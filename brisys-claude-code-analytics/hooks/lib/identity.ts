// 送信元の識別情報 (email / hostname / project / git remote) の解決。

import { firstNonEmpty, homeDir } from './config'
import { gitToplevel, remoteOriginUrl } from './git'
import { readText, runQuiet } from './host'
import { joinPath } from './paths'
import type { Config, Dollar, EmailSource, GitRemoteSource, Origin } from './types'

/** `.claude.json` の `oauthAccount.emailAddress`。壊れた JSON・キー不在・空文字は undefined。 */
export function emailFromClaudeJson(text: string): string | undefined {
  try {
    const email = JSON.parse(text)?.oauthAccount?.emailAddress
    return typeof email === 'string' && email.trim() ? email.trim() : undefined
  } catch {
    return undefined
  }
}

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
export async function resolveEmail(
  $: Dollar,
  config: Config,
  telemetryEmail: string | undefined,
): Promise<{ email: string; source: EmailSource } | undefined> {
  if (config.emailOverride) return { email: config.emailOverride, source: 'override' }
  if (telemetryEmail) return { email: telemetryEmail, source: 'telemetry' }
  const base = firstNonEmpty(await $.env.get('CLAUDE_CONFIG_DIR')) ?? (await homeDir($))
  if (!base) return undefined
  const text = await readText($, joinPath(base, '.claude.json'))
  const email = text === undefined ? undefined : emailFromClaudeJson(text)
  return email ? { email, source: 'login-record' } : undefined
}

let hostCache: { hostname: string; platform: string } | undefined

/**
 * hostname と OS。hostname は旧 collector と同じく Windows は `COMPUTERNAME`、
 * それ以外は `uname -n` の値 (macOS の os.hostname() と同じ)。取れなければ `unknown-host`。
 */
export async function resolveHost($: Dollar): Promise<{ hostname: string; platform: string }> {
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

let versionCache: string | undefined

/**
 * BQ の `collector_version` は「配布されているプラグインの版」なので plugin.json の version を読む。
 * 読めなければ `unknown`。
 */
export async function collectorVersion($: Dollar): Promise<string> {
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
export async function resolveOrigin(
  $: Dollar,
  config: Config,
  cwd: string,
  telemetryEmail: string | undefined,
): Promise<Origin | undefined> {
  const email = await resolveEmail($, config, telemetryEmail)
  if (!email) return undefined
  const host = await resolveHost($)
  const remote: { url?: string; source: GitRemoteSource } = config.disableGitRemote
    ? { source: 'disabled' }
    : await remoteOriginUrl($, cwd)
  return {
    project: config.projectOverride ?? (await gitToplevel($, cwd)) ?? cwd,
    email: email.email,
    emailSource: email.source,
    hostname: host.hostname,
    platform: host.platform,
    collectorVersion: await collectorVersion($),
    gitRemoteUrl: remote.url,
    gitRemoteSource: remote.source,
  }
}
