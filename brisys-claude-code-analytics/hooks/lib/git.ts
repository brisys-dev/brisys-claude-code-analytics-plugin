// git リポジトリ情報の解決。旧 collector (git.rs) の移植で、値の互換を要件にしている
// (project と git_remote_url は BQ にそのまま入るため、表記が変わると別物として集計される)。
//
// `.git` を直接読むのを第 1 段、git コマンドをフォールバックにする。直読で解釈できない設定
// (include / includeIf、--global の remote 定義など) が効いている環境ではコマンドが正しい値を返す。

import { readText, runQuiet, statKind } from './host'
import { gitStylePath, isAbsolutePath, joinPath, normalizePath, parentDir } from './paths'
import type { Dollar, GitRemoteSource } from './types'

/** API 側の Zod schema と揃えた上限。 */
const REMOTE_URL_MAX_LENGTH = 512
/** `.git` を探して上位へ遡る回数の上限。 */
const MAX_PARENT_HOPS = 32
/** gitfile の `gitdir:` を辿る回数の上限 (循環対策)。 */
const MAX_GITFILE_HOPS = 5

/** `.git` を持つ最も近い祖先を、`git rev-parse --show-toplevel` と同じ表記で返す。 */
export async function gitToplevel($: Dollar, cwd: string): Promise<string | undefined> {
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

/** origin の remote URL と、どこから取ったか。 */
export async function remoteOriginUrl($: Dollar, cwd: string): Promise<{ url?: string; source: GitRemoteSource }> {
  if (!cwd) return { source: 'none' }
  const gitDir = await resolveGitDir($, cwd)
  if (gitDir) {
    const config = await readText($, joinPath(gitDir, 'config'))
    const url = config === undefined ? undefined : extractOriginUrl(config)
    const sanitized = url === undefined ? undefined : sanitizeRemoteUrl(url)
    if (sanitized) return { url: sanitized, source: 'file' }
  }
  const url = await runQuiet($, ['git', '-C', cwd, 'config', '--get', 'remote.origin.url'])
  const sanitized = url === undefined ? undefined : sanitizeRemoteUrl(url)
  return sanitized ? { url: sanitized, source: 'git' } : { source: 'none' }
}
