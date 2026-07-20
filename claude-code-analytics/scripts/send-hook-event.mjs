#!/usr/bin/env node

// Claude Code Hook Collector — Node.js 実装
// 外部依存なし。Node.js 標準ライブラリのみで動作する。

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";

// changelog (履歴: hard-coded 定数管理時代)
//   0.4.0: event 送信 body に top-level フィールド `git_remote_url` を追加.
//     Node.js 有り端末では cwd から `git config --get remote.origin.url` を試み、
//     失敗時は `.git/config` 直読の 2 段フォールバックで解決する.
//     `AI_ANALYTICS_DISABLE_GIT_REMOTE=1` で opt-out.
//     canonical な project 識別子 (owner/repo) は下流 (dbt) の normalize 処理で導出.
//   0.3.0: SessionStart / transcript batch trigger 用に責務を縮小.
//     http hook 対応の 8 event (SessionEnd / UserPromptSubmit / PostToolUse /
//     PostToolUseFailure / SubagentStart / SubagentStop / Stop / StopFailure)
//     は type:"http" として managed settings 経由で送信されるため、Node.js に
//     依存しない。本 script は http 非対応の SessionStart と、transcript batch
//     (SessionEnd / SubagentStop の `--transcript-only`) のみを担う。
//   0.2.0: http hook 併用 (`--transcript-only` フラグを追加).
//
// Issue #7: plugin package の calver (`.claude-plugin/plugin.json` の `version`) を
// 実行時に読み取り、hook 送信 body の collector_version に採用する.
// - hard-coded 定数の manual sync 忘れによる rollout 追跡精度低下を防ぐ.
// - dashboard 側は raw の collector_version から「plugin package 分布」を直接算出できる.
// - plugin.json の read 失敗時は "unknown" にフォールバックし、hook 送信は止めない (fail-open).
const _pluginJsonPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".claude-plugin",
  "plugin.json",
);
const COLLECTOR_VERSION = (() => {
  try {
    const parsed = JSON.parse(readFileSync(_pluginJsonPath, "utf8"));
    return typeof parsed?.version === "string" && parsed.version.length > 0
      ? parsed.version
      : "unknown";
  } catch {
    return "unknown";
  }
})();
const PARSER_VERSION = COLLECTOR_VERSION;

// git_remote_url payload 最大長 (API 側 Zod schema と一致させる).
const GIT_REMOTE_URL_MAX_LENGTH = 512;
// git_remote_url 許容文字 (API 側 Zod schema と一致させる, 制御文字禁止).
const GIT_REMOTE_URL_ALLOWED_PATTERN = /^[A-Za-z0-9@:/._+-]+$/;

const EVENT_TYPE_MAP = {
  SessionStart: "session.started",
  SessionEnd: "session.ended",
  UserPromptSubmit: "message.submitted",
  PostToolUse: "tool.used",
  PostToolUseFailure: "tool.failed",
  SubagentStart: "subagent.started",
  SubagentStop: "subagent.completed",
};

// --- stdin 読み取り ---

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// --- フィールド抽出ユーティリティ ---

function extractStringField(input, fieldName) {
  if (input && typeof input === "object" && typeof input[fieldName] === "string") {
    return input[fieldName];
  }
  return "";
}

function extractToolInputFilePath(input) {
  if (
    input &&
    typeof input === "object" &&
    input.tool_input &&
    typeof input.tool_input === "object" &&
    typeof input.tool_input.file_path === "string"
  ) {
    return input.tool_input.file_path;
  }
  return "";
}

// --- ローカル情報の解決 ---

// ~/.claude.json の OAuth 情報からメールアドレスを取得する
// ファイル不在・パース失敗・キー不在等すべて空文字にフォールバック
// homeOverride: テスト用にホームディレクトリを差し替えるオプション引数
function resolveEmailFromClaudeJson(homeOverride) {
  try {
    const home = homeOverride || homedir();
    if (!home) return "";

    const claudeJsonPath = join(home, ".claude.json");
    const content = readFileSync(claudeJsonPath, "utf8");
    const parsed = JSON.parse(content);

    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.oauthAccount &&
      typeof parsed.oauthAccount === "object" &&
      typeof parsed.oauthAccount.emailAddress === "string"
    ) {
      const email = parsed.oauthAccount.emailAddress.trim();
      if (email.length > 0) return email;
    }

    return "";
  } catch {
    return "";
  }
}

// homeOverride: テスト用にホームディレクトリを差し替えるオプション引数
function resolveEmail(homeOverride) {
  const envEmail = process.env.AI_ANALYTICS_USER_EMAIL || "";
  if (envEmail) {
    return envEmail;
  }

  // OAuth ログイン情報から取得を試みる
  const claudeJsonEmail = resolveEmailFromClaudeJson(homeOverride);
  if (claudeJsonEmail) {
    return claudeJsonEmail;
  }

  try {
    return execFileSync("git", ["config", "--global", "user.email"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function resolveHostname() {
  try {
    return hostname();
  } catch {
    return "unknown-host";
  }
}

function resolveProject(rawCwd) {
  const envProject = process.env.AI_ANALYTICS_PROJECT || "";
  if (envProject) {
    return envProject;
  }

  if (rawCwd) {
    try {
      const gitRoot = execFileSync("git", ["-C", rawCwd, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (gitRoot) {
        return gitRoot;
      }
    } catch {
      // git が使えない場合は cwd にフォールバック
    }
  }

  return rawCwd || "";
}

// cwd から `git config --get remote.origin.url` を取得する.
// 2 段フォールバック:
//   1. `git` バイナリが使える環境では execFileSync で取得 (最も信頼できる source of truth)
//   2. `git` が失敗 / 存在しない場合は `.git/config` を直読して origin url を抽出
//      (`.git` が gitfile の worktree / submodule では `gitdir:` を辿る)
// opt-out: AI_ANALYTICS_DISABLE_GIT_REMOTE=1 で常に null を返す.
// テスト用の runOverride は `git` execFile の代替関数を差し込むためのオプション引数.
function resolveGitRemoteUrl(rawCwd, runOverride) {
  if (process.env.AI_ANALYTICS_DISABLE_GIT_REMOTE === "1") {
    return null;
  }

  if (!rawCwd) return null;

  const runner = typeof runOverride === "function"
    ? runOverride
    : (args) => execFileSync("git", args, {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });

  // Step 1: `git config --get remote.origin.url` を試行
  try {
    const url = runner(["-C", rawCwd, "config", "--get", "remote.origin.url"]).trim();
    if (url) {
      return sanitizeGitRemoteUrl(url);
    }
  } catch {
    // git が使えない / 未初期化 の場合は Step 2 の .git/config フォールバックへ
  }

  // Step 2: .git/config 直読フォールバック
  try {
    const gitDir = resolveGitDir(rawCwd);
    if (gitDir) {
      const configPath = join(gitDir, "config");
      if (isReadableFile(configPath)) {
        const configText = readFileSync(configPath, "utf8");
        const url = extractOriginUrlFromConfig(configText);
        if (url) {
          return sanitizeGitRemoteUrl(url);
        }
      }
    }
  } catch {
    // config ファイル読み取り失敗はそのまま null
  }

  return null;
}

// cwd から `.git` ディレクトリを解決する. `.git` がファイル (gitfile) の場合は
// `gitdir: <path>` を再帰的に辿る (循環防止のため max 5 hop).
function resolveGitDir(rawCwd) {
  let current = rawCwd;

  // .git の場所を上位ディレクトリまで探索
  for (let hop = 0; hop < 32; hop++) {
    const dotGit = join(current, ".git");

    let stat;
    try {
      stat = statSync(dotGit);
    } catch {
      // 上位に遡る
      const parent = resolve(current, "..");
      if (parent === current) return null;
      current = parent;
      continue;
    }

    if (stat.isDirectory()) {
      return dotGit;
    }

    if (stat.isFile()) {
      // gitfile: `gitdir: <path>` を辿る (worktree / submodule 対応, max 5 hop で循環防止)
      let gitfilePath = dotGit;
      for (let follow = 0; follow < 5; follow++) {
        let gitdir;
        try {
          const content = readFileSync(gitfilePath, "utf8");
          const match = /^gitdir:\s*(.+)$/m.exec(content);
          if (!match) return null;
          gitdir = match[1].trim();
        } catch {
          return null;
        }

        // 相対パスなら gitfile のディレクトリを基準に解決
        const gitfileDir = gitfilePath.endsWith(".git")
          ? gitfilePath.slice(0, -".git".length) || "."
          : resolve(gitfilePath, "..");
        const resolved = resolve(gitfileDir, gitdir);

        let resolvedStat;
        try {
          resolvedStat = statSync(resolved);
        } catch {
          return null;
        }

        if (resolvedStat.isDirectory()) {
          return resolved;
        }
        if (resolvedStat.isFile()) {
          gitfilePath = resolved;
          continue;
        }
        return null;
      }
      return null;
    }

    return null;
  }

  return null;
}

// .git/config テキストから [remote "origin"] セクションの url を抽出する.
// git-config は行指向で `[section]` の後に `key = value` が続く. 空白と大文字小文字を
// 許容し、`origin` セクションのみを対象にする.
function extractOriginUrlFromConfig(configText) {
  const lines = configText.split(/\r?\n/);
  let inOrigin = false;

  for (const line of lines) {
    const sectionMatch = /^\s*\[\s*([A-Za-z0-9._-]+)(?:\s+"([^"]*)")?\s*\]\s*$/.exec(line);
    if (sectionMatch) {
      const section = sectionMatch[1].toLowerCase();
      const subsection = sectionMatch[2] || "";
      inOrigin = section === "remote" && subsection === "origin";
      continue;
    }

    if (!inOrigin) continue;

    const kvMatch = /^\s*([A-Za-z0-9._-]+)\s*=\s*(.*)$/.exec(line);
    if (!kvMatch) continue;

    if (kvMatch[1].toLowerCase() === "url") {
      // 末尾コメント (`; comment` / `# comment` 相当) は git-config には無いので単純に trim
      return kvMatch[2].trim();
    }
  }

  return null;
}

// API 側 schema の制約 (max 512 chars / 許容文字集合) を満たさない値は送信しない.
// マッチしなければ null を返し、payload には含めない.
function sanitizeGitRemoteUrl(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > GIT_REMOTE_URL_MAX_LENGTH) return null;
  if (!GIT_REMOTE_URL_ALLOWED_PATTERN.test(trimmed)) return null;
  return trimmed;
}

// --- スナップショット管理 (PreToolUse / PostToolUse の差分計算用) ---

function sanitizeIdentifier(value) {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_");
}

function toolSnapshotPath(stateDir, sessionId, toolUseId) {
  return join(stateDir, `${sanitizeIdentifier(sessionId)}__${sanitizeIdentifier(toolUseId)}.before`);
}

function isReadableFile(filePath) {
  if (!filePath) return false;
  try {
    const stat = statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function capturePreToolSnapshot(toolName, sessionId, toolUseId, filePath, stateDir) {
  if (toolName !== "Edit" && toolName !== "Write") return;
  if (!sessionId || !toolUseId) return;

  const snapshotPath = toolSnapshotPath(stateDir, sessionId, toolUseId);

  try {
    mkdirSync(stateDir, { recursive: true });
  } catch {
    return;
  }

  try {
    if (isReadableFile(filePath)) {
      copyFileSync(filePath, snapshotPath);
    } else {
      writeFileSync(snapshotPath, "", "utf8");
    }
  } catch {
    // スナップショット保存失敗は握りつぶす
  }
}

// --- 行数計算 ---

// awk 'END { print NR + 0 }' 相当: 改行区切りのレコード数を返す
function countLinesInText(text) {
  if (!text) return 0;
  const lines = text.split("\n");
  // 末尾の空要素を除外（末尾改行の場合）
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length;
}

// --- diff 計算 (diff -U0 相当の added/deleted 行数) ---

// LCS の長さを計算し、added/deleted を導出する
// diff -U0 + awk の結果と一致する
function computeLineDiff(beforeText, afterText) {
  const beforeLines = splitLines(beforeText);
  const afterLines = splitLines(afterText);

  const lcs = lcsLength(beforeLines, afterLines);

  return {
    addedLines: afterLines.length - lcs,
    deletedLines: beforeLines.length - lcs,
  };
}

// 改行で分割し、末尾の空行を除外
function splitLines(text) {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

// 最長共通部分列の長さを O(min(m,n)) 空間で計算
function lcsLength(a, b) {
  // 短い方を a にしてメモリを節約
  if (a.length > b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }

  const m = a.length;
  const n = b.length;
  let prev = new Array(m + 1).fill(0);
  let curr = new Array(m + 1).fill(0);

  for (let j = 1; j <= n; j++) {
    for (let i = 1; i <= m; i++) {
      if (a[i - 1] === b[j - 1]) {
        curr[i] = prev[i - 1] + 1;
      } else {
        curr[i] = prev[i] > curr[i - 1] ? prev[i] : curr[i - 1];
      }
    }
    const swap = prev;
    prev = curr;
    curr = swap;
    curr.fill(0);
  }

  return prev[m];
}

// --- PostToolUse の行数統計 JSON 生成 ---

function buildToolLineStats(toolName, sessionId, toolUseId, filePath, stateDir) {
  if (toolName !== "Edit" && toolName !== "Write") return null;
  if (!sessionId || !toolUseId) return null;

  const snapshotPath = toolSnapshotPath(stateDir, sessionId, toolUseId);

  if (!existsSync(snapshotPath)) return null;

  let beforeText = "";
  let afterText = "";

  try {
    beforeText = readFileSync(snapshotPath, "utf8");
  } catch {
    // 読み取り失敗は空として扱う
  }

  try {
    if (isReadableFile(filePath)) {
      afterText = readFileSync(filePath, "utf8");
    }
  } catch {
    // 読み取り失敗は空として扱う
  }

  const beforeLines = countLinesInText(beforeText);
  const afterLines = countLinesInText(afterText);
  const diff = computeLineDiff(beforeText, afterText);

  // スナップショットを削除
  try {
    rmSync(snapshotPath, { force: true });
  } catch {
    // 削除失敗は握りつぶす
  }

  return {
    mode: "file_diff",
    before_lines: beforeLines,
    after_lines: afterLines,
    added_lines: diff.addedLines,
    deleted_lines: diff.deletedLines,
    changed_lines: diff.addedLines + diff.deletedLines,
  };
}

// --- Redaction ---

function redactPayload(payload, toolLineStats) {
  const toolName = payload.tool_name;

  if (toolName === "Edit" && payload.tool_input && typeof payload.tool_input === "object") {
    const redacted = { ...payload, tool_input: { ...payload.tool_input } };
    if (typeof redacted.tool_input.old_string === "string") {
      redacted.tool_input.old_string = "[REDACTED]";
    }
    if (typeof redacted.tool_input.new_string === "string") {
      redacted.tool_input.new_string = "[REDACTED]";
    }
    if (toolLineStats) {
      redacted.tool_line_stats = toolLineStats;
    }
    return redacted;
  }

  if (toolName === "Write" && payload.tool_input && typeof payload.tool_input === "object") {
    const redacted = { ...payload, tool_input: { ...payload.tool_input } };
    if (typeof redacted.tool_input.content === "string") {
      redacted.tool_input.content = "[REDACTED]";
    }
    if (toolLineStats) {
      redacted.tool_line_stats = toolLineStats;
    }
    return redacted;
  }

  return payload;
}

// --- イベント JSON 構築 ---

// gitRemoteUrl: v0.4.0 で追加した optional な top-level フィールド.
// null / undefined の場合はリクエスト body に含めない (旧 API 互換のため).
function buildEventJson(hookInput, email, hostnameValue, projectValue, eventAt, toolLineStats, gitRemoteUrl = null) {
  if (typeof hookInput !== "object" || hookInput === null) return null;

  const eventType = EVENT_TYPE_MAP[hookInput.hook_event_name];
  if (!eventType) return null;

  if (typeof hookInput.session_id !== "string" || hookInput.session_id.length === 0) return null;
  if (!projectValue) return null;

  // payload: session_id, cwd, hook_event_name, null値 を除外した残り
  const payload = {};
  for (const [key, value] of Object.entries(hookInput)) {
    if (key === "session_id" || key === "cwd" || key === "hook_event_name" || key === "prompt" || key === "tool_response" || key === "last_assistant_message") continue;
    if (value === null || value === undefined) continue;
    payload[key] = value;
  }

  const redactedPayload = redactPayload(payload, toolLineStats);

  const eventJson = {
    event_type: eventType,
    event_at: eventAt,
    session_id: hookInput.session_id,
    project: projectValue,
    email,
    hostname: hostnameValue,
    collector_version: COLLECTOR_VERSION,
    payload: redactedPayload,
  };

  // git_remote_url は取得できた場合のみ含める. 旧 API と互換性を保ちつつ、
  // 新 API 側では Zod schema の nullable().optional() で受ける.
  if (typeof gitRemoteUrl === "string" && gitRemoteUrl.length > 0) {
    eventJson.git_remote_url = gitRemoteUrl;
  }

  return eventJson;
}

// --- トークン使用量の抽出 ---

// transcript の assistant メッセージから requestId 単位でトークン使用量を集計し、
// モデルごとに1つの transcript.token_usage イベントを生成する
function extractTokenUsageEvents(lines) {
  // requestId → 最後の assistant 行をマッピング（ストリーミング中間行を排除）
  const lastByRequestId = new Map();

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line || typeof line !== "object") continue;
    if (line.type !== "assistant") continue;
    if (!line.message || !line.message.usage) continue;

    const requestId = line.requestId || line.message?.id || `idx-${index}`;
    lastByRequestId.set(requestId, { line, index });
  }

  // モデルごとに集計
  const byModel = new Map();
  let lastTimestamp = null;

  for (const { line } of lastByRequestId.values()) {
    const model = line.message.model || "unknown";
    const usage = line.message.usage;

    if (!byModel.has(model)) {
      byModel.set(model, {
        request_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        service_tier: null,
      });
    }

    const agg = byModel.get(model);
    agg.request_count += 1;
    agg.input_tokens += usage.input_tokens || 0;
    agg.output_tokens += usage.output_tokens || 0;
    agg.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
    agg.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
    if (usage.service_tier) {
      agg.service_tier = usage.service_tier;
    }

    // セッション中の最後のタイムスタンプを記録
    if (typeof line.timestamp === "string" && line.timestamp.length > 0) {
      if (!lastTimestamp || line.timestamp > lastTimestamp) {
        lastTimestamp = line.timestamp;
      }
    }
  }

  const eventAt = lastTimestamp || new Date().toISOString().replace(/\.\d{3}Z$/u, ".000Z");
  const events = [];

  for (const [model, agg] of byModel) {
    events.push({
      event_type: "transcript.token_usage",
      event_at: eventAt,
      transcript_line_number: null,
      transcript_line_uuid: null,
      content_index: null,
      source_record_type: "assistant",
      source_record_subtype: null,
      payload: {
        model,
        request_count: agg.request_count,
        input_tokens: agg.input_tokens,
        output_tokens: agg.output_tokens,
        cache_creation_input_tokens: agg.cache_creation_input_tokens,
        cache_read_input_tokens: agg.cache_read_input_tokens,
        service_tier: agg.service_tier,
      },
    });
  }

  return events;
}

// --- Transcript 解析 ---

function extractTag(text, tagName) {
  const parts = text.split(`<${tagName}>`);
  if (parts.length < 2) return null;
  const afterOpen = parts[1];
  const closeParts = afterOpen.split(`</${tagName}>`);
  return closeParts[0].trim();
}

function commandTextFromLine(line) {
  if (
    line.type === "user" &&
    line.message &&
    typeof line.message.content === "string"
  ) {
    return line.message.content;
  }

  if (
    line.type === "system" &&
    typeof line.subtype === "string" &&
    line.subtype === "local_command" &&
    typeof line.content === "string"
  ) {
    return line.content;
  }

  return null;
}

function buildTranscriptBatchJson(transcriptPath, includeCommands, eventJson, email, hostnameValue, agentId, agentType) {
  if (!isReadableFile(transcriptPath)) return null;

  let lines;
  try {
    const content = readFileSync(transcriptPath, "utf8").trim();
    if (!content) return null;
    lines = content.split("\n").map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    });
  } catch {
    return null;
  }

  const events = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line || typeof line !== "object") continue;
    if (typeof line.timestamp !== "string" || line.timestamp.length === 0) continue;

    // command_detected イベントの抽出
    if (includeCommands) {
      const commandText = commandTextFromLine(line);
      if (typeof commandText === "string") {
        const rawCommandName = extractTag(commandText, "command-name");
        if (typeof rawCommandName === "string" && rawCommandName.length > 0) {
          const commandName = rawCommandName.replace(/^\//u, "").trim();
          if (commandName.length > 0) {
            const commandArgs = extractTag(commandText, "command-args");

            events.push({
              event_type: "transcript.command_detected",
              event_at: line.timestamp,
              transcript_line_number: index + 1,
              transcript_line_uuid: line.uuid || null,
              content_index: null,
              source_record_type: line.type,
              source_record_subtype: line.subtype || null,
              payload: {
                command_name: commandName,
                raw_command_name: rawCommandName,
                has_args: typeof commandArgs === "string" && commandArgs.trim().length > 0,
                args_redacted: true,
              },
            });
          }
        }
      }
    }

    // skill_detected イベントの抽出
    if (
      line.type === "assistant" &&
      line.message &&
      Array.isArray(line.message.content)
    ) {
      for (let contentIndex = 0; contentIndex < line.message.content.length; contentIndex++) {
        const content = line.message.content[contentIndex];
        if (
          content &&
          content.type === "tool_use" &&
          content.name === "Skill" &&
          typeof content.id === "string" &&
          content.id.length > 0 &&
          content.input &&
          typeof content.input.skill === "string" &&
          content.input.skill.length > 0
        ) {
          const skillPayload = {
            skill_name: content.input.skill,
            tool_use_id: content.id,
            caller_type:
              content.caller && typeof content.caller.type === "string"
                ? content.caller.type
                : null,
            has_args:
              typeof content.input.args === "string" && content.input.args.length > 0,
            args_redacted: true,
          };

          // agent 情報の付加
          if (agentId && agentId.length > 0) {
            skillPayload.agent_id = agentId;
          }
          if (agentType && agentType.length > 0) {
            skillPayload.agent_type = agentType;
          }

          events.push({
            event_type: "transcript.skill_detected",
            event_at: line.timestamp,
            transcript_line_number: index + 1,
            transcript_line_uuid: line.uuid || null,
            content_index: contentIndex,
            source_record_type: line.type,
            source_record_subtype: null,
            payload: skillPayload,
          });
        }
      }
    }
  }

  // token_usage イベントの抽出（モデル別セッション集計）
  const tokenEvents = extractTokenUsageEvents(lines);
  events.push(...tokenEvents);

  if (events.length === 0) return null;

  return {
    session_id: eventJson.session_id,
    project: eventJson.project,
    email,
    hostname: hostnameValue,
    collector_version: COLLECTOR_VERSION,
    parser_version: PARSER_VERSION,
    transcript_path: transcriptPath,
    events,
  };
}

// --- HTTP POST ---

function postJson(apiUrl, apiKey, endpoint, body) {
  if (!body) return Promise.resolve();

  const url = new URL(endpoint, apiUrl.replace(/\/$/u, ""));
  const bodyStr = JSON.stringify(body);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve) => {
    try {
      const request = transport.request(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "X-Collector-Version": COLLECTOR_VERSION,
            "Content-Length": Buffer.byteLength(bodyStr),
          },
          timeout: 30000,
        },
        (response) => {
          // レスポンスを消費して完了を待つ
          response.resume();
          response.on("end", () => resolve());
          response.on("error", (err) => {
            console.error("[ai-analytics-hook]", err);
            resolve();
          });
        },
      );

      request.on("error", (err) => {
        console.error("[ai-analytics-hook]", err);
        resolve();
      });
      request.on("timeout", () => {
        console.error("[ai-analytics-hook] request timeout");
        request.destroy();
        resolve();
      });

      request.end(bodyStr);
    } catch (err) {
      console.error("[ai-analytics-hook]", err);
      resolve();
    }
  });
}

// --- エントリーポイント ---

async function main() {
  // `--transcript-only` は SessionEnd / SubagentStop で transcript batch のみ
  // 送信するモード。hook event 本体は managed settings 側の type:"http"
  // hook が /api/v1/hook-events に直接送るため、collector は transcript batch
  // (transcript.token_usage / command_detected / skill_detected) のみを
  // /api/v1/transcript-events に送る責務を担う。
  const isTranscriptOnly = process.argv.includes("--transcript-only");

  // DEV用の環境変数が設定されていれば優先する（remote-settings.json の値を上書きできる）
  const apiUrl = process.env.AI_ANALYTICS_DEV_API_URL || process.env.AI_ANALYTICS_API_URL || "";
  const apiKey = process.env.AI_ANALYTICS_DEV_API_KEY || process.env.AI_ANALYTICS_API_KEY || "";

  if (!apiUrl || !apiKey) {
    process.exit(0);
  }

  const email = resolveEmail();
  if (!email) {
    process.exit(0);
  }

  const hostnameValue = resolveHostname();
  const hookInputRaw = readStdin();

  if (!hookInputRaw) {
    process.exit(0);
  }

  let hookInput;
  try {
    hookInput = JSON.parse(hookInputRaw);
  } catch {
    process.exit(0);
  }

  if (typeof hookInput !== "object" || hookInput === null) {
    process.exit(0);
  }

  const hookEventName = extractStringField(hookInput, "hook_event_name");
  const sessionId = extractStringField(hookInput, "session_id");
  const toolName = extractStringField(hookInput, "tool_name");
  const toolUseId = extractStringField(hookInput, "tool_use_id");
  const toolFilePath = extractToolInputFilePath(hookInput);

  const stateDir =
    process.env.AI_ANALYTICS_STATE_DIR ||
    join(process.env.TMPDIR || process.env.TEMP || "/tmp", "ai-analytics-hook-state");

  // PreToolUse はスナップショットを取って終了
  // (行数統計は http hook に移行できないため、当面 collector で残す。
  //  将来 #19 の OTEL `claude_code.lines_of_code.count` へ移行する)
  if (hookEventName === "PreToolUse") {
    capturePreToolSnapshot(toolName, sessionId, toolUseId, toolFilePath, stateDir);
    process.exit(0);
  }

  // PostToolUse / PostToolUseFailure は http hook で受けるため、
  // 行数統計付きの event 送信はここでは行わない。
  // (Phase 2 で PreToolUse も廃止する予定 — snapshot 側だけ生き残る現状は暫定)
  let toolLineStats = null;
  if (!isTranscriptOnly && (hookEventName === "PostToolUse" || hookEventName === "PostToolUseFailure")) {
    toolLineStats = buildToolLineStats(toolName, sessionId, toolUseId, toolFilePath, stateDir);
  }

  const rawCwd = extractStringField(hookInput, "cwd");
  const projectValue = resolveProject(rawCwd);
  const gitRemoteUrl = resolveGitRemoteUrl(rawCwd);
  const eventAt = new Date().toISOString().replace(/\.\d{3}Z$/u, ".000Z");

  const eventJson = buildEventJson(hookInput, email, hostnameValue, projectValue, eventAt, toolLineStats, gitRemoteUrl);
  if (!eventJson) {
    process.exit(0);
  }

  let transcriptBatchJson = null;

  if (hookEventName === "SessionEnd") {
    const transcriptPath = extractStringField(hookInput, "transcript_path");
    transcriptBatchJson = buildTranscriptBatchJson(
      transcriptPath,
      true,
      eventJson,
      email,
      hostnameValue,
      "",
      "",
    );
  } else if (hookEventName === "SubagentStop") {
    const agentTranscriptPath = extractStringField(hookInput, "agent_transcript_path");
    const agentId = extractStringField(hookInput, "agent_id");
    const agentType = extractStringField(hookInput, "agent_type");
    transcriptBatchJson = buildTranscriptBatchJson(
      agentTranscriptPath,
      false,
      eventJson,
      email,
      hostnameValue,
      agentId,
      agentType,
    );
  }

  // http hook で受ける event は collector からは event 送信しない。
  // hooks.json 側で `--transcript-only` を付与された呼び出しがこれに該当する。
  const requests = [];
  if (!isTranscriptOnly) {
    requests.push(postJson(apiUrl, apiKey, "/api/v1/events", eventJson));
  }
  if (transcriptBatchJson) {
    requests.push(postJson(apiUrl, apiKey, "/api/v1/transcript-events", transcriptBatchJson));
  }
  await Promise.all(requests);
}

// 直接実行時のみ main() を起動（テストからの import 時はスキップ）
// fileURLToPath + resolve で OS ネイティブ形式に揃えて比較（Windows/macOS 両対応）
const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  main().catch((err) => {
    // Claude Code の体験に影響させないが、verbose モードで確認可能にする
    console.error("[ai-analytics-hook]", err);
    process.exitCode = 0;
  });
}

export {
  COLLECTOR_VERSION,
  buildEventJson,
  buildToolLineStats,
  buildTranscriptBatchJson,
  capturePreToolSnapshot,
  computeLineDiff,
  countLinesInText,
  extractOriginUrlFromConfig,
  extractTokenUsageEvents,
  redactPayload,
  resolveEmail,
  resolveEmailFromClaudeJson,
  resolveGitDir,
  resolveGitRemoteUrl,
  sanitizeGitRemoteUrl,
};
