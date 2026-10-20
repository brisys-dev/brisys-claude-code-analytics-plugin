// パス操作。mod の実行環境には Node が無いので、`/` と `\` の両方を手で扱う。

/** Windows のドライブ表記 (`C:\` / `C:/`) か UNC (`\\host`) で始まるか。 */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || isWindowsPath(path)
}

/** dir の区切り文字に合わせて name を継ぎ足す (`\` だけを使う dir なら `\`)。 */
export function joinPath(dir: string, name: string): string {
  if (dir.endsWith('/') || dir.endsWith('\\')) return dir + name
  const separator = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return dir + separator + name
}

/** 親ディレクトリ。ルート (`/`、`C:\`) より上は無いので undefined。 */
export function parentDir(path: string): string | undefined {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (index < 0) return undefined
  if (index === 0) return '/'
  const parent = trimmed.slice(0, index)
  if (/^[A-Za-z]:$/.test(parent)) return parent + trimmed[index]
  return parent
}

/** `.` と `..` を畳む (シンボリックリンクは辿らない)。 */
export function normalizePath(path: string): string {
  const separator = path.includes('\\') && !path.includes('/') ? '\\' : '/'
  const out: string[] = []
  for (const part of path.split(/[\\/]/)) {
    if (part === '.') continue
    if (part === '..') {
      if (out.length > 1) out.pop()
      continue
    }
    out.push(part)
  }
  return out.join(separator)
}

/**
 * `git rev-parse --show-toplevel` と同じ表記にする。Windows は `C:/...`
 * (verbatim の `\\?\` を外して区切りを `/` に)。この値は project として BQ に入るので、
 * 旧 collector と表記がずれると同じリポジトリが別 project として集計される。
 */
export function gitStylePath(path: string): string {
  const stripped = path.startsWith('\\\\?\\') ? path.slice(4) : path
  return isWindowsPath(stripped) ? stripped.replaceAll('\\', '/') : stripped
}

/** Claude Code が transcript を置くプロジェクトディレクトリ名 (英数字以外を `-` に)。 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * メインの transcript の場所: `<設定ディレクトリ>/projects/<slug>/<session_id>.jsonl`。
 * hook 入力の `transcript_path` と同じ値になる (実測)。transcript 系の event_id の一部。
 */
export function mainTranscriptPath(configDir: string, cwd: string, sessionId: string): string {
  return joinPath(joinPath(joinPath(configDir, 'projects'), projectSlug(cwd)), `${sessionId}.jsonl`)
}

/** サブエージェントの transcript の場所: `.../<session_id>/subagents/agent-<agent_id>.jsonl`。 */
export function subagentTranscriptPath(mainPath: string, sessionId: string, agentId: string): string {
  const dir = parentDir(mainPath) ?? ''
  return joinPath(joinPath(joinPath(dir, sessionId), 'subagents'), `agent-${agentId}.jsonl`)
}

/**
 * このプラグインがどの経路で読み込まれたか (診断用)。
 * claude.ai の組織同期なら `plugins/synced/`、マーケットプレイスからなら `plugins/cache/` の下にある。
 */
export function deliveryRoute(pluginRoot: string): 'synced' | 'marketplace' | 'local' {
  const normalized = pluginRoot.replaceAll('\\', '/')
  if (normalized.includes('/plugins/synced/')) return 'synced'
  if (normalized.includes('/plugins/cache/')) return 'marketplace'
  return 'local'
}
