// git の設定テキストの解釈。旧 collector (git.rs) の移植で、値の互換を要件にしている
// (project と git_remote_url は BQ にそのまま入るため、表記が変わると別物として集計される)。
//
// `.git` を探して読む処理は `$` を使うので register.ts にある。ここには文字列だけを扱う関数を置く。

/** API 側の Zod schema と揃えた上限。 */
const REMOTE_URL_MAX_LENGTH = 512

/** HEAD のローカルブランチ名。detached HEAD・reftable のダミー・不正な ref は返さない。 */
export function branchFromHead(head: string): string | undefined {
  const match = /^ref: refs\/heads\/([^\r\n]+)\r?\n?$/.exec(head)
  const branch = match?.[1]
  // 異常に長い値は切り詰めず省略する (別のブランチと同じ値にしない)。
  if (!branch || branch.length > 1024) return undefined
  if (/[\s~^:?*[\\]/.test(branch)) return undefined
  if ([...branch].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return undefined
  if (branch.includes('..') || branch.includes('@{') || branch.endsWith('.')) return undefined
  if (branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))) return undefined
  return branch
}

/** git-config のテキストから `[remote "origin"]` の url を取り出す。 */
export function extractOriginUrl(config: string): string | undefined {
  let inOrigin = false
  for (const line of config.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inOrigin = isRemoteOriginSection(trimmed.slice(1, -1))
      continue
    }
    if (!inOrigin) continue
    const eq = trimmed.indexOf('=')
    if (eq >= 0 && trimmed.slice(0, eq).trim().toLowerCase() === 'url') return trimmed.slice(eq + 1).trim()
  }
  return undefined
}

/** `remote "origin"` のセクションか。セクション名は大文字小文字を区別せず、subsection は区別する。 */
function isRemoteOriginSection(section: string): boolean {
  const match = section.trim().match(/^(\S+)\s+(.*)$/)
  if (match?.[1]?.toLowerCase() !== 'remote') return false
  return (match?.[2] ?? '').trim().replace(/^"+|"+$/g, '') === 'origin'
}

/**
 * http(s) の URL に埋め込まれた資格情報 (`https://user:token@host/...`) を外す。
 * scp 形式 (`git@host:owner/repo.git`) や ssh の `git@` はユーザー名なので残す。
 */
export function stripCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@]*@/i, '$1')
}

/** API 側の制約 (最大長・許容文字) を満たさない値は送らない。資格情報は外してから検査する。 */
export function sanitizeRemoteUrl(url: string): string | undefined {
  const cleaned = stripCredentials(url.trim())
  if (!cleaned || cleaned.length > REMOTE_URL_MAX_LENGTH) return undefined
  return /^[A-Za-z0-9@:/._+-]+$/.test(cleaned) ? cleaned : undefined
}
