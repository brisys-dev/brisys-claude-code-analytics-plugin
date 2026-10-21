// Claude Code の利用統計を集めて ai-analytics の API へ送る mod。
//
// 旧 collector (Rust バイナリの command hook) と同じ body を送る:
//   - session.started            -> POST /api/v1/events
//   - Skill / スラッシュコマンド   -> POST /api/v1/transcript-events
// 送信先とキーは managed settings の env (AI_ANALYTICS_API_URL / AI_ANALYTICS_API_KEY) で配られ、
// 無ければ何もしない。
//
// GitHub のマーケットプレイスや claude.ai の組織同期から入る mod は「ユーザー扱い」で、
// managed settings のある端末では組込みガード (cc-plugin-sec-default) が classic.* を渡さない。
// そのため従来の hook 入力 (classic.SessionStart など) は使わず、届くイベントだけで組んでいる。
//
// `$` を使う処理は、すべてこのファイルに置く。Claude Code 2.1.298 以前の解析器は、`$` を
// 別ファイルから import した関数に渡す書き方を読めず、モジュールごと読み込まない
// ("$ is followed only into a function declared in this same file, never across an import")。
// lib/ には `$` を受け取らない純粋な関数だけを置く。
//
// 観測したもの (session.started、Skill / コマンドの検出) はすぐ outbox に保存し、
// ターン完了・timer・session.end で送る。送れなかったものは outbox に残り、次の機会に送る。
// どの処理で失敗しても、Claude の操作は止めない (例外は guard で握って debug log に出す)。

import type { EngineInterface, Register } from 'claude-code'
import { millisIso, originDiagnostics, secondsIso, sessionStartedBody, transcriptBatchBody } from './lib/body'
import { firstNonEmpty } from './lib/config'
import {
  DELIVERY_OBSERVATION_VERSION,
  DISTRIBUTION_FILE,
  distributionLabel,
  distributionRepository,
  manifestVersion,
  pluginLocation,
  type SyncedScan,
  safeToken,
  syncedCopyFields,
} from './lib/delivery'
import { commandEvent, mayHoldDetection, type Row, skillEvents } from './lib/detect'
import { extractOriginUrl, sanitizeRemoteUrl } from './lib/git'
import { classify, headerValuesAreSafe, joinUrl, type PostResult, parseRetryAfter } from './lib/http'
import { emailFromClaudeJson } from './lib/identity'
import {
  backoffMs,
  isOutboxRecord,
  ORIGIN_PREFIX,
  OUTBOX_PREFIX,
  type OutboxRecord,
  QUARANTINE_PREFIX,
  recordKey,
  STATS_KEY,
  type Stats,
} from './lib/outbox'
import {
  gitStylePath,
  isAbsolutePath,
  joinPath,
  mainTranscriptPath,
  normalizePath,
  parentDir,
  subagentTranscriptPath,
} from './lib/paths'
import type { Config, EmailSource, GitRemoteSource, JsonObject, Origin } from './lib/types'

type Dollar = EngineInterface

/** timer で送る間隔。 */
const FLUSH_INTERVAL_MS = 30_000
/** セッション開始から最初に送るまで (前回までの残りもここで送る)。 */
const FIRST_FLUSH_DELAY_MS = 5_000
/** 別のセッションが作ったものは、作ってからこの時間が過ぎたら引き取る (そのセッションの終了後の残り)。 */
const ADOPT_AFTER_MS = 10 * 60_000
/** これより古いものは捨てる。 */
const MAX_AGE_MS = 7 * 24 * 60 * 60_000
/** outbox の件数の上限 (`$.store` は全体で 4 MiB まで)。超えたら古いものから捨てる。 */
const MAX_PENDING = 1000
/** 隔離しておく件数の上限。 */
const MAX_QUARANTINED = 100
/** 送信元の記録を残しておく時間 (そのセッションの outbox が空になった後)。 */
const ORIGIN_RETENTION_MS = 24 * 60 * 60_000
/** session.end の持ち時間 (3 秒) のうち送信に使う時間。残りは次のセッションで送る。 */
const SESSION_END_DEADLINE_MS = 1500
/** git などのローカル操作の待ち時間。ネットワークを伴うコマンドは呼ばない。 */
const LOCAL_COMMAND_TIMEOUT_MS = 5000
/** `.git` を探して上位へ遡る回数の上限。 */
const MAX_PARENT_HOPS = 32
/** gitfile の `gitdir:` を辿る回数の上限 (循環対策)。 */
const MAX_GITFILE_HOPS = 5
/** 組織同期の写しを探すとき、見る bucket (アカウントごとのディレクトリ) の数の上限。 */
const MAX_SYNCED_BUCKETS = 20

type SessionInfo = { cwd: string; transcriptPath: string }
type StoredOrigin = { v: 1; createdAt: number; origin: Origin }

// モジュールの変数は、モジュールの再読み込みで初期値に戻る。続きは outbox から再開する。
let config: Config | undefined
let configRead = false
let currentSessionId: string | undefined
let lastCwd: string | undefined
let lastEndReason: string | undefined
let timerStarted = false
let delivering: Promise<void> | undefined
let stopAt: number | undefined
let hostCache: { hostname: string; platform: string } | undefined
let versionCache: string | undefined
let repositoryCache: string | null | undefined
let entrypointCache: string | null | undefined
// 直近の session.start の入力。/clear の後のセッションも同じ画面・同じ起動のしかたなので引き継ぐ
let lastSurface: string | null = null
let lastInteractive: boolean | null = null
const sessions = new Map<string, SessionInfo>()
const emailBySession = new Map<string, string>()
const agentTypes = new Map<string, string>()
const origins = new Map<string, Origin>()

export const register: Register = (on) => {
  // エンジンのテレメトリから、セッションの実際のアカウントを覚える (OTEL の user.email と同じ値)
  on('telemetry.log', { to: 'collector' }, async (_$, e, next) => {
    if (e.to === 'collector') rememberTelemetry(e.attributes)
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await guard($, 'session.start', () => onSessionStart($, e.cwd, e.surface ?? null, e.isInteractive ?? null))
    return result
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await guard($, 'turn.start', () => onMainTurnStart($))
    return result
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (stored.deny === undefined) {
      await guard($, 'session.append', () => onRow($, stored.message, stored.uuid, e.agentId))
    }
    return stored
  })

  on('agent.spawn', async (_$, e, next) => {
    const result = await next(e)
    if (result.deny === undefined && result.agentId) agentTypes.set(result.agentId, e.subagentType)
    return result
  })

  // ターンの完了を待たせないよう、送信は待たずに返す
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void deliver($)
    return result
  })

  on('session.end', async ($, e, next) => {
    await guard($, 'session.end', () => onSessionEnd($, e.sessionId, e.reason))
    return next(e)
  })
}

// ---- 共通 ----

/** debug log (`claude --debug`) に書く。失敗は常に、成功は AI_ANALYTICS_DEBUG=1 のときだけ。 */
function log($: Dollar, text: string, always = true): void {
  if (!always && !config?.debug) return
  try {
    $.ui.log(`[analytics] ${text}`, { to: 'debug' })
  } catch {}
}

/** フックの本体を包む。例外は外へ出さず debug log に残す (フックが飛ばされないように)。 */
async function guard($: Dollar, label: string, work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch (error) {
    log($, `${label} で失敗: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** telemetry.log の属性から、そのセッションのアカウント (OTEL と同じ値) を覚える。 */
function rememberTelemetry(attributes: Readonly<Record<string, unknown>>): void {
  const email = attributes['user.email']
  const sessionId = attributes['session.id']
  if (typeof email === 'string' && email && typeof sessionId === 'string' && sessionId) {
    emailBySession.set(sessionId, email)
  }
}

// ---- 設定 (環境変数) ----

/**
 * 環境変数から設定を読む。送信先かキーが無ければ undefined を返し、何も送らない。
 *
 * `AI_ANALYTICS_DEV_*` は managed settings の値を手元で一時的に上書きして検証するためのもの
 * (旧 collector と同じ優先順)。`$.env.get` は名前を文字列リテラルで書く必要がある
 * (`claude plugin validate` が読み取れない名前のモジュールは読み込まれない)。
 */
async function loadConfig($: Dollar): Promise<Config | undefined> {
  if (configRead) return config
  configRead = true
  const apiUrl = firstNonEmpty(await $.env.get('AI_ANALYTICS_DEV_API_URL'), await $.env.get('AI_ANALYTICS_API_URL'))
  const apiKey = firstNonEmpty(await $.env.get('AI_ANALYTICS_DEV_API_KEY'), await $.env.get('AI_ANALYTICS_API_KEY'))
  if (!apiUrl || !apiKey) return undefined
  config = {
    apiUrl,
    apiKey,
    projectOverride: firstNonEmpty(await $.env.get('AI_ANALYTICS_PROJECT')),
    emailOverride: firstNonEmpty(await $.env.get('AI_ANALYTICS_USER_EMAIL')),
    disableGitRemote: (await $.env.get('AI_ANALYTICS_DISABLE_GIT_REMOTE')) === '1',
    debug: (await $.env.get('AI_ANALYTICS_DEBUG')) === '1',
  }
  return config
}

/** ホームディレクトリ (Unix は HOME、Windows は USERPROFILE)。 */
async function homeDir($: Dollar): Promise<string | undefined> {
  return firstNonEmpty(await $.env.get('HOME'), await $.env.get('USERPROFILE'))
}

/**
 * Claude Code の設定ディレクトリ。`CLAUDE_CONFIG_DIR` が無ければ `~/.claude`。
 * transcript の保存先と、ログイン記録 (`.claude.json`) の場所を決めるのに使う。
 */
async function claudeConfigDir($: Dollar): Promise<{ dir: string; explicit: boolean } | undefined> {
  const explicit = firstNonEmpty(await $.env.get('CLAUDE_CONFIG_DIR'))
  if (explicit) return { dir: explicit, explicit: true }
  const home = await homeDir($)
  return home === undefined ? undefined : { dir: joinPath(home, '.claude'), explicit: false }
}

// ---- ファイルとプロセス (失敗はすべて undefined にして呼び出し元で後退させる) ----

/** パスの種類。存在しなければ undefined。 */
async function statKind($: Dollar, path: string): Promise<'file' | 'dir' | 'other' | undefined> {
  try {
    return (await $.fs.stat(path)).kind
  } catch {
    return undefined
  }
}

/** テキストを読む。無い・4 MiB 超・読めないときは undefined。 */
async function readText($: Dollar, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

/** コマンドを実行し、成功したときだけ trim した標準出力を返す (空なら undefined)。 */
async function runQuiet($: Dollar, argv: string[]): Promise<string | undefined> {
  try {
    const result = await $.process.run(argv, { timeoutMs: LOCAL_COMMAND_TIMEOUT_MS })
    if (result.exitCode !== 0) return undefined
    return result.stdout.trim() || undefined
  } catch {
    return undefined
  }
}

// ---- git (旧 collector の git.rs の移植。project と git_remote_url は BQ にそのまま入るので値の互換を守る) ----

/** `.git` を持つ最も近い祖先を、`git rev-parse --show-toplevel` と同じ表記で返す。 */
async function gitToplevel($: Dollar, cwd: string): Promise<string | undefined> {
  if (!cwd) return undefined
  let current: string | undefined = cwd
  for (let hop = 0; hop < MAX_PARENT_HOPS && current; hop++) {
    const kind = await statKind($, joinPath(current, '.git'))
    if (kind === 'file' || kind === 'dir') {
      // git はシンボリックリンクを解決した物理パスを返す (macOS の /tmp は /private/tmp)
      let resolved = current
      try {
        resolved = (await $.fs.stat(current, { resolve: true })).realPath ?? current
      } catch {}
      return gitStylePath(resolved)
    }
    current = parentDir(current)
  }
  return runQuiet($, ['git', '-C', cwd, 'rev-parse', '--show-toplevel'])
}

/** cwd から `.git` ディレクトリを解決する。worktree / submodule の gitfile なら `gitdir:` を辿る。 */
async function resolveGitDir($: Dollar, start: string): Promise<string | undefined> {
  let current: string | undefined = start
  for (let hop = 0; hop < MAX_PARENT_HOPS && current; hop++) {
    const dotGit = joinPath(current, '.git')
    const kind = await statKind($, dotGit)
    if (kind === 'dir') return dotGit
    if (kind === 'file') return followGitfile($, dotGit)
    if (kind === 'other') return undefined
    current = parentDir(current)
  }
  return undefined
}

async function followGitfile($: Dollar, gitfile: string): Promise<string | undefined> {
  let path = gitfile
  for (let hop = 0; hop < MAX_GITFILE_HOPS; hop++) {
    const content = await readText($, path)
    if (content === undefined) return undefined
    const line = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith('gitdir:'))
    const target = line?.slice('gitdir:'.length).trim()
    if (!target) return undefined
    const base = parentDir(path)
    if (!base) return undefined
    // 相対パスは gitfile のあるディレクトリ基準
    const resolved = isAbsolutePath(target) ? target : normalizePath(joinPath(base, target))
    const kind = await statKind($, resolved)
    if (kind === 'dir') return resolved
    if (kind !== 'file') return undefined
    path = resolved
  }
  return undefined
}

/**
 * origin の remote URL と、どこから取ったか。`.git/config` の直読を第 1 段、git コマンドを
 * フォールバックにする (直読で解釈できない include などが効いている環境ではコマンドが正しい値を返す)。
 */
async function remoteOriginUrl($: Dollar, cwd: string): Promise<{ url?: string; source: GitRemoteSource }> {
  if (!cwd) return { source: 'none' }
  const gitDir = await resolveGitDir($, cwd)
  if (gitDir) {
    const text = await readText($, joinPath(gitDir, 'config'))
    const url = text === undefined ? undefined : extractOriginUrl(text)
    const sanitized = url === undefined ? undefined : sanitizeRemoteUrl(url)
    if (sanitized) return { url: sanitized, source: 'file' }
  }
  const url = await runQuiet($, ['git', '-C', cwd, 'config', '--get', 'remote.origin.url'])
  const sanitized = url === undefined ? undefined : sanitizeRemoteUrl(url)
  return sanitized ? { url: sanitized, source: 'git' } : { source: 'none' }
}

// ---- 送信元の識別情報 ----

/**
 * email を決める。上から順に試し、決まらなければ undefined (そのセッションは送らない)。
 *
 * 1. `AI_ANALYTICS_USER_EMAIL` (CI のボットなど、ログインしていない実行)
 * 2. エンジンのテレメトリ (`telemetry.log`) の `user.email` のうち、同じ session.id のもの。
 *    OTEL と同じ「実際にログインしているアカウント」
 * 3. 今使っている設定ディレクトリのログイン記録。`CLAUDE_CONFIG_DIR` があればその `.claude.json` だけ、
 *    無ければ `~/.claude.json`
 *
 * 別アカウントの `~/.claude.json` や git の author email には後退しない。旧 collector は
 * `~/.claude.json` 固定で、複数アカウントを使い分ける端末のセッションを別人に計上していた。
 */
async function resolveEmail(
  $: Dollar,
  cfg: Config,
  telemetryEmail: string | undefined,
): Promise<{ email: string; source: EmailSource } | undefined> {
  if (cfg.emailOverride) return { email: cfg.emailOverride, source: 'override' }
  if (telemetryEmail) return { email: telemetryEmail, source: 'telemetry' }
  const base = firstNonEmpty(await $.env.get('CLAUDE_CONFIG_DIR')) ?? (await homeDir($))
  if (!base) return undefined
  const text = await readText($, joinPath(base, '.claude.json'))
  const email = text === undefined ? undefined : emailFromClaudeJson(text)
  return email ? { email, source: 'login-record' } : undefined
}

/**
 * hostname と OS。hostname は旧 collector と同じく Windows は `COMPUTERNAME`、
 * それ以外は `uname -n` の値 (macOS の os.hostname() と同じ)。取れなければ `unknown-host`。
 */
async function resolveHost($: Dollar): Promise<{ hostname: string; platform: string }> {
  if (hostCache) return hostCache
  const computer = firstNonEmpty(await $.env.get('COMPUTERNAME'))
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  let sysname: string | undefined
  let nodename: string | undefined
  if (!isWindows) {
    // `uname -sn` は「Darwin host.local」のように sysname、nodename の順に出す
    const parts = (await runQuiet($, ['uname', '-sn']))?.split(/\s+/) ?? []
    sysname = parts[0]
    nodename = parts[1]
  }
  hostCache = {
    hostname: computer ?? nodename ?? 'unknown-host',
    platform: isWindows ? 'windows' : (sysname?.toLowerCase() ?? 'unknown'),
  }
  return hostCache
}

/**
 * BQ の `collector_version` は「配布されているプラグインの版」なので plugin.json の version を読む。
 * 読めなければ `unknown`。
 */
async function collectorVersion($: Dollar): Promise<string> {
  if (versionCache) return versionCache
  const text = await readText($, joinPath(joinPath($.plugin.root, '.claude-plugin'), 'plugin.json'))
  let version = 'unknown'
  try {
    const parsed = text === undefined ? undefined : JSON.parse(text)?.version
    if (typeof parsed === 'string' && parsed) version = parsed
  } catch {}
  versionCache = version
  return version
}

/**
 * セッションの送信元を決める。email が決まらなければ undefined。
 * project は `AI_ANALYTICS_PROJECT` → git のトップレベル → cwd の順 (旧 collector と同じ)。
 */
async function resolveOrigin(
  $: Dollar,
  cfg: Config,
  cwd: string,
  telemetryEmail: string | undefined,
): Promise<Origin | undefined> {
  const email = await resolveEmail($, cfg, telemetryEmail)
  if (!email) return undefined
  const host = await resolveHost($)
  const remote: { url?: string; source: GitRemoteSource } = cfg.disableGitRemote
    ? { source: 'disabled' }
    : await remoteOriginUrl($, cwd)
  return {
    project: cfg.projectOverride ?? (await gitToplevel($, cwd)) ?? cwd,
    email: email.email,
    emailSource: email.source,
    hostname: host.hostname,
    platform: host.platform,
    collectorVersion: await collectorVersion($),
    gitRemoteUrl: remote.url,
    gitRemoteSource: remote.source,
  }
}

/**
 * セッションの送信元。一度決めたら `$.store` に固定し、同じセッションのすべての送信で使う。
 * 再送やモジュールの再読み込みで email などが変わると、同じ event_id に違う本文が並ぶため。
 */
async function originFor($: Dollar, cfg: Config, record: OutboxRecord, now: number): Promise<Origin | undefined> {
  const cached = origins.get(record.sessionId)
  if (cached) return cached
  const key = ORIGIN_PREFIX + record.sessionId
  const stored = (await $.store.get(key)) as StoredOrigin | undefined
  if (stored?.v === 1 && stored.origin) {
    origins.set(record.sessionId, stored.origin)
    return stored.origin
  }
  const origin = await resolveOrigin($, cfg, record.cwd, emailBySession.get(record.sessionId))
  if (!origin) return undefined
  const value: StoredOrigin = { v: 1, createdAt: now, origin }
  await $.store.set(key, value)
  origins.set(record.sessionId, origin)
  return origin
}

// ---- 配布経路の診断 (lib/delivery.ts の説明を参照) ----

/**
 * どこから届いたこのプラグインが送っているかと、組織同期の写しが届いているか。
 * session.started の payload に載せる。読めないものは null や unknown にして、送信は止めない。
 */
async function observeDelivery($: Dollar): Promise<JsonObject> {
  const location = pluginLocation($.plugin.root)
  // --plugin-dir などで場所から分からないときは、今のセッションの設定ディレクトリを見る
  const configDir = location.configDir ?? (await claudeConfigDir($))?.dir
  const scan: SyncedScan =
    configDir === undefined
      ? { found: 0, versions: [], complete: false, error: 'unrecognized_root' }
      : await scanSyncedCopies($, configDir)
  return {
    delivery_observation_version: DELIVERY_OBSERVATION_VERSION,
    delivery_repository: await deliveryRepository($),
    delivery: location.route,
    delivery_marketplace: distributionLabel(location.marketplace),
    ...syncedCopyFields(scan),
  }
}

/** 配布物の `distribution.json` に書かれたリポジトリ (正本か public ミラーか)。 */
async function deliveryRepository($: Dollar): Promise<string | null> {
  if (repositoryCache !== undefined) return repositoryCache
  const text = await readText($, joinPath($.plugin.root, DISTRIBUTION_FILE))
  repositoryCache = distributionLabel(text === undefined ? undefined : distributionRepository(text))
  return repositoryCache
}

/**
 * `<設定ディレクトリ>/plugins/synced/<bucket>/<このプラグイン>/.claude-plugin/plugin.json` を数える。
 * bucket はアカウントごとのディレクトリで、名前にアカウントの uuid を含むので送らない。
 */
async function scanSyncedCopies($: Dollar, configDir: string): Promise<SyncedScan> {
  const syncedRoot = joinPath(joinPath(configDir, 'plugins'), 'synced')
  const scan: SyncedScan = { found: 0, versions: [], complete: true }
  try {
    // 同期の置き場が無いのは、組織同期が届いていないということ (調べられなかったのとは違う)
    if (!(await $.fs.exists(syncedRoot))) return scan
    const buckets = (await $.fs.list(syncedRoot)).filter((entry) => entry.kind === 'dir' && !entry.name.startsWith('.'))
    for (const [index, bucket] of buckets.entries()) {
      if (index >= MAX_SYNCED_BUCKETS) return { ...scan, complete: false, error: 'limit_exceeded' }
      const manifest = joinPath(
        joinPath(joinPath(joinPath(syncedRoot, bucket.name), $.plugin.name), '.claude-plugin'),
        'plugin.json',
      )
      if (!(await $.fs.exists(manifest))) continue
      scan.found += 1
      const text = await readText($, manifest)
      scan.versions.push(text === undefined ? undefined : manifestVersion(text))
    }
    return scan
  } catch {
    return { ...scan, complete: false, error: 'io_error' }
  }
}

/** Claude Code の起動のしかた (`CLAUDE_CODE_ENTRYPOINT`。cli・claude-desktop・sdk-ts など)。 */
async function entrypoint($: Dollar): Promise<string | null> {
  if (entrypointCache === undefined) entrypointCache = safeToken(await $.env.get('CLAUDE_CODE_ENTRYPOINT'))
  return entrypointCache
}

// ---- outbox ($.store) ----

/** まだ無ければ保存する (同じキーの本文を書き換えない)。保存したら true。 */
async function persistRecord($: Dollar, record: OutboxRecord): Promise<boolean> {
  const key = recordKey(record)
  if ((await $.store.get(key)) !== undefined) return false
  await $.store.set(key, record)
  return true
}

async function readStats($: Dollar): Promise<Stats> {
  const value = (await $.store.get(STATS_KEY)) as Partial<Stats> | undefined
  return { dropped: Number(value?.dropped ?? 0), quarantined: Number(value?.quarantined ?? 0) }
}

/** 捨てた件数・隔離した件数を足す。複数セッションの同時更新で数え漏れはありうる (目安の値)。 */
async function bumpStats($: Dollar, field: keyof Stats, n = 1): Promise<void> {
  const stats = await readStats($)
  stats[field] += n
  await $.store.set(STATS_KEY, stats)
}

// ---- セッションの観測 ----

function startTimer($: Dollar): void {
  if (timerStarted) return
  timerStarted = true
  $.clock.after(FIRST_FLUSH_DELAY_MS, () => void deliver($))
  $.clock.every(FLUSH_INTERVAL_MS, () => void deliver($))
}

/** session.start: 起動・再開したセッションを記録し、送信の timer を始める。 */
async function onSessionStart(
  $: Dollar,
  cwd: string,
  surface: string | null,
  interactive: boolean | null,
): Promise<void> {
  lastSurface = surface
  lastInteractive = interactive
  if (!(await loadConfig($))) return
  const sessionId = await $.session.id()
  currentSessionId = sessionId
  const source = (await $.session.turns()) > 0 ? 'resume' : 'startup'
  await noteSession($, sessionId, cwd, source)
  startTimer($)
}

/**
 * メインの turn.start: `/clear` の後は session.start が来ないので、新しい session id をここで拾う。
 * mod が session.start より後に読み込まれた場合 (信頼の確認を待った場合など) も、ここで始める。
 */
async function onMainTurnStart($: Dollar): Promise<void> {
  if (!(await loadConfig($))) return
  const sessionId = await $.session.id()
  if (sessionId === currentSessionId && sessions.has(sessionId)) return
  currentSessionId = sessionId
  await noteSession($, sessionId, lastCwd ?? (await $.session.cwd()), nextSource())
  startTimer($)
}

/** session.start を経ずに見つけたセッションの source。直前の session.end の理由を引き継ぐ。 */
function nextSource(): string {
  if (sessions.size === 0) return 'startup'
  return lastEndReason === 'resume' ? 'resume' : 'clear'
}

/**
 * セッションを記録し、session.started を outbox に保存する (すでに記録済みなら何もしない)。
 * 時刻はここで固定し、再送でも作り直さない (event_id = session.started:<session_id>:<event_at>)。
 */
async function noteSession($: Dollar, sessionId: string, cwd: string, source: string): Promise<SessionInfo> {
  const known = sessions.get(sessionId)
  if (known) return known
  const configDir = await claudeConfigDir($)
  const info: SessionInfo = {
    cwd,
    transcriptPath: configDir ? mainTranscriptPath(configDir.dir, cwd, sessionId) : `${sessionId}.jsonl`,
  }
  sessions.set(sessionId, info)
  lastCwd = cwd
  // モジュールの再読み込みでは session.start がもう一度走る。送信元を記録済み (= 送信済み) の
  // セッションは session.started を別の時刻で作り直さない (raw に余計な行が増えるだけなので)
  if ((await $.store.get(ORIGIN_PREFIX + sessionId)) !== undefined) return info
  const now = await $.clock.now()
  const snapshot = await outboxSnapshot($, now)
  const payload: JsonObject = {
    source,
    model: await $.session.model(),
    transcript_path: info.transcriptPath,
    claude_code_version: (await $.session.version()).version,
    collector_kind: 'mod',
    ...(await observeDelivery($)),
    surface: safeToken(lastSurface),
    interactive: lastInteractive,
    entrypoint: await entrypoint($),
    outbox_pending: snapshot.pending,
    outbox_oldest_age_seconds: snapshot.oldestAgeSeconds,
    outbox_dropped_total: snapshot.dropped,
    outbox_quarantined_total: snapshot.quarantined,
  }
  await persistRecord($, {
    v: 1,
    kind: 'session.started',
    sessionId,
    cwd,
    transcriptPath: info.transcriptPath,
    createdAt: now,
    event: { event_at: secondsIso(now), payload },
    attempts: 0,
    nextAt: 0,
  })
  return info
}

/** セッション開始時点の outbox の状態 (前回までの残り)。診断用に session.started に載せる。 */
async function outboxSnapshot(
  $: Dollar,
  now: number,
): Promise<{ pending: number; oldestAgeSeconds: number | null; dropped: number; quarantined: number }> {
  const keys = (await $.store.keys()).filter((key) => key.startsWith(OUTBOX_PREFIX))
  let oldest: number | undefined
  // キーは入れた順に並ぶので、古いものは先頭にある
  for (const key of keys.slice(0, 50)) {
    const record = await $.store.get(key)
    if (isOutboxRecord(record)) oldest = Math.min(oldest ?? record.createdAt, record.createdAt)
  }
  const stats = await readStats($)
  return {
    pending: keys.length,
    oldestAgeSeconds: oldest === undefined ? null : Math.max(0, Math.round((now - oldest) / 1000)),
    dropped: stats.dropped,
    quarantined: stats.quarantined,
  }
}

/**
 * session.append の row から Skill / コマンドを取り出して outbox に保存する。
 * 行ごとに呼ばれるので、候補にならない行は `$` を呼ばずに返す。
 */
async function onRow($: Dollar, row: Row, uuid: string, agentId: string | undefined): Promise<void> {
  if (configRead && !config) return
  if (!mayHoldDetection(row)) return
  if (!(await loadConfig($))) return
  const now = await $.clock.now()
  const eventAt = millisIso(now)
  if (currentSessionId === undefined) currentSessionId = await $.session.id()
  const sessionId = currentSessionId
  const info =
    sessions.get(sessionId) ?? (await noteSession($, sessionId, lastCwd ?? (await $.session.cwd()), nextSource()))
  const base = {
    v: 1 as const,
    kind: 'transcript' as const,
    sessionId,
    cwd: info.cwd,
    createdAt: now,
    attempts: 0,
    nextAt: 0,
  }

  if (agentId === undefined) {
    // スラッシュコマンドはメインの会話にしか現れない (旧 collector も SessionEnd の transcript だけを見ていた)
    const events = [commandEvent(row, uuid, eventAt), ...skillEvents(row, uuid, eventAt)]
    for (const event of events) {
      if (event) await persistRecord($, { ...base, transcriptPath: info.transcriptPath, event })
    }
    return
  }

  const events = skillEvents(row, uuid, eventAt)
  if (events.length === 0) return
  const agentType = agentTypes.get(agentId) ?? (await $.agent.list()).find((agent) => agent.id === agentId)?.type
  for (const event of events) {
    const payload: JsonObject = {
      ...(event.payload as JsonObject),
      agent_id: agentId,
      ...(agentType ? { agent_type: agentType } : {}),
    }
    await persistRecord($, {
      ...base,
      transcriptPath: subagentTranscriptPath(info.transcriptPath, sessionId, agentId),
      event: { ...event, payload },
    })
  }
}

/** session.end: 持ち時間の範囲で送り、送れなかった分は outbox に残す。 */
async function onSessionEnd($: Dollar, sessionId: string, reason: string): Promise<void> {
  if (await loadConfig($)) {
    stopAt = (await $.clock.now()) + SESSION_END_DEADLINE_MS
    try {
      await deliver($)
    } finally {
      stopAt = undefined
    }
  }
  lastEndReason = reason
  if (sessionId === currentSessionId) currentSessionId = undefined
}

// ---- 送信 ----

/** JSON を POST する。通信の失敗も含めて例外は投げない。 */
async function postJson($: Dollar, cfg: Config, path: string, body: JsonObject, version: string): Promise<PostResult> {
  if (!headerValuesAreSafe(cfg.apiKey, version)) {
    return { kind: 'error', reason: 'ヘッダ値に改行が含まれている' }
  }
  try {
    const response = await $.http.fetch(joinUrl(cfg.apiUrl, path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
        'X-Collector-Version': version,
      },
      body: JSON.stringify(body),
    })
    return { kind: 'response', status: response.status, retryAfterMs: parseRetryAfter(response.headers['retry-after']) }
  } catch (error) {
    return { kind: 'error', reason: error instanceof Error ? error.message : String(error) }
  }
}

/** outbox を送る。すでに送っている最中なら、その完了を待つ。 */
function deliver($: Dollar): Promise<void> {
  if (!delivering) {
    delivering = deliverOnce($)
      .catch((error) => log($, `送信で失敗: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        delivering = undefined
      })
  }
  return delivering
}

async function deliverOnce($: Dollar): Promise<void> {
  const cfg = await loadConfig($)
  if (!cfg) return
  let now = await $.clock.now()
  const keys = await enforceCapacity(
    $,
    (await $.store.keys()).filter((key) => key.startsWith(OUTBOX_PREFIX)),
  )
  for (const key of keys) {
    if (stopAt !== undefined && now >= stopAt) break
    const record = await $.store.get(key)
    // 知らない形式 (将来の版など) は消さない
    if (!isOutboxRecord(record)) continue
    if (record.nextAt > now) continue
    const own = sessions.has(record.sessionId)
    if (!own && now - record.createdAt < ADOPT_AFTER_MS) continue
    if (now - record.createdAt > MAX_AGE_MS) {
      await $.store.delete(key)
      await bumpStats($, 'dropped')
      log($, `${key} は 7 日を過ぎたので捨てた`)
      continue
    }
    const origin = await originFor($, cfg, record, now)
    // email が決まらないうちは送らない (7 日を過ぎたら上で捨てる)
    if (!origin) continue
    const request = requestFor(record, origin)
    const result = await postJson($, cfg, request.path, request.body, origin.collectorVersion)
    now = await $.clock.now()
    const disposition = classify(result)
    const status = statusOf(result)
    if (disposition === 'sent') {
      await $.store.delete(key)
      log($, `POST ${request.path} -> ${status}`, false)
      continue
    }
    if (disposition === 'quarantine') {
      await quarantine($, key, record, status, now)
      log($, `POST ${request.path} -> ${status} (本文の誤りとして隔離した)`)
      continue
    }
    const attempts = record.attempts + 1
    const retryAfter = result.kind === 'response' ? (result.retryAfterMs ?? 0) : 0
    const wait = Math.max(backoffMs(attempts, disposition, Math.random()), retryAfter)
    await $.store.set(key, { ...record, attempts, nextAt: now + wait, lastStatus: status })
    log($, `POST ${request.path} -> ${status} (${Math.round(wait / 1000)} 秒後に再送する)`)
  }
  await pruneOrigins($, keys, now)
}

/** 件数の上限を超えた分を古い順に捨て、残ったキーを返す。 */
async function enforceCapacity($: Dollar, keys: string[]): Promise<string[]> {
  const excess = keys.length - MAX_PENDING
  if (excess <= 0) return keys
  for (const key of keys.slice(0, excess)) await $.store.delete(key)
  await bumpStats($, 'dropped', excess)
  log($, `outbox が上限 ${MAX_PENDING} 件を超えたので古い ${excess} 件を捨てた`)
  return keys.slice(excess)
}

/** 本文の誤りで送れないものを隔離する (調べられるように残す)。上限を超えたら古い順に捨てる。 */
async function quarantine($: Dollar, key: string, record: OutboxRecord, status: string, now: number): Promise<void> {
  await $.store.set(QUARANTINE_PREFIX + key.slice(OUTBOX_PREFIX.length), {
    ...record,
    lastStatus: status,
    quarantinedAt: now,
  })
  await $.store.delete(key)
  await bumpStats($, 'quarantined')
  const quarantined = (await $.store.keys()).filter((k) => k.startsWith(QUARANTINE_PREFIX))
  for (const old of quarantined.slice(0, Math.max(0, quarantined.length - MAX_QUARANTINED))) await $.store.delete(old)
}

/** outbox が空になったセッションの送信元の記録を、一定時間後に消す。 */
async function pruneOrigins($: Dollar, outboxKeys: string[], now: number): Promise<void> {
  const pendingSessions = new Set(outboxKeys.map((key) => key.slice(OUTBOX_PREFIX.length).split('/')[0]))
  for (const key of (await $.store.keys()).filter((k) => k.startsWith(ORIGIN_PREFIX))) {
    const sessionId = key.slice(ORIGIN_PREFIX.length)
    if (sessions.has(sessionId) || pendingSessions.has(sessionId)) continue
    const stored = (await $.store.get(key)) as StoredOrigin | undefined
    if (!stored || now - Number(stored.createdAt ?? 0) > ORIGIN_RETENTION_MS) await $.store.delete(key)
  }
}

function requestFor(record: OutboxRecord, origin: Origin): { path: string; body: JsonObject } {
  if (record.kind === 'session.started') {
    const payload = { ...(record.event.payload as JsonObject), ...originDiagnostics(origin) }
    return {
      path: '/api/v1/events',
      body: sessionStartedBody(record.sessionId, String(record.event.event_at), origin, payload),
    }
  }
  return {
    path: '/api/v1/transcript-events',
    body: transcriptBatchBody(record.sessionId, record.transcriptPath, origin, [record.event]),
  }
}

function statusOf(result: PostResult): string {
  return result.kind === 'response' ? String(result.status) : `error: ${result.reason.slice(0, 120)}`
}
