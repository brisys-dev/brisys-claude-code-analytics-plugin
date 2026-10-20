import { joinPath } from './paths'
import type { Config, Dollar } from './types'

/** 与えた値を順に見て、最初の空でない値を trim して返す。 */
export function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

/**
 * 環境変数から設定を読む。送信先かキーが無ければ undefined を返し、何も送らない。
 *
 * `AI_ANALYTICS_DEV_*` は managed settings の値を手元で一時的に上書きして検証するためのもの
 * (旧 collector と同じ優先順)。`$.env.get` は名前を文字列リテラルで書く必要がある
 * (`claude plugin validate` が読み取れない名前のモジュールは読み込まれない)。
 */
export async function readConfig($: Dollar): Promise<Config | undefined> {
  const apiUrl = firstNonEmpty(await $.env.get('AI_ANALYTICS_DEV_API_URL'), await $.env.get('AI_ANALYTICS_API_URL'))
  const apiKey = firstNonEmpty(await $.env.get('AI_ANALYTICS_DEV_API_KEY'), await $.env.get('AI_ANALYTICS_API_KEY'))
  if (!apiUrl || !apiKey) return undefined
  return {
    apiUrl,
    apiKey,
    projectOverride: firstNonEmpty(await $.env.get('AI_ANALYTICS_PROJECT')),
    emailOverride: firstNonEmpty(await $.env.get('AI_ANALYTICS_USER_EMAIL')),
    disableGitRemote: (await $.env.get('AI_ANALYTICS_DISABLE_GIT_REMOTE')) === '1',
    debug: (await $.env.get('AI_ANALYTICS_DEBUG')) === '1',
  }
}

/** ホームディレクトリ (Unix は HOME、Windows は USERPROFILE)。 */
export async function homeDir($: Dollar): Promise<string | undefined> {
  return firstNonEmpty(await $.env.get('HOME'), await $.env.get('USERPROFILE'))
}

/**
 * Claude Code の設定ディレクトリ。`CLAUDE_CONFIG_DIR` が無ければ `~/.claude`。
 * transcript の保存先を組み立てるのに使う。`explicit` は `CLAUDE_CONFIG_DIR` で指定されたか。
 */
export async function claudeConfigDir($: Dollar): Promise<{ dir: string; explicit: boolean } | undefined> {
  const explicit = firstNonEmpty(await $.env.get('CLAUDE_CONFIG_DIR'))
  if (explicit) return { dir: explicit, explicit: true }
  const home = await homeDir($)
  return home === undefined ? undefined : { dir: joinPath(home, '.claude'), explicit: false }
}
