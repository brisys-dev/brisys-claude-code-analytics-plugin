// ファイルとプロセスの操作。失敗はすべて undefined にして呼び出し元で後退させる
// (収集の失敗で Claude の操作を止めない)。

import type { Dollar } from './types'

/** git などのローカル操作の待ち時間。ネットワークを伴うコマンドは呼ばない。 */
const LOCAL_COMMAND_TIMEOUT_MS = 5000

/** パスの種類。存在しなければ undefined。 */
export async function statKind($: Dollar, path: string): Promise<'file' | 'dir' | 'other' | undefined> {
  try {
    return (await $.fs.stat(path)).kind
  } catch {
    return undefined
  }
}

/** テキストを読む。無い・4 MiB 超・読めないときは undefined。 */
export async function readText($: Dollar, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

/** コマンドを実行し、成功したときだけ trim した標準出力を返す (空なら undefined)。 */
export async function runQuiet($: Dollar, argv: string[]): Promise<string | undefined> {
  try {
    const result = await $.process.run(argv, { timeoutMs: LOCAL_COMMAND_TIMEOUT_MS })
    if (result.exitCode !== 0) return undefined
    return result.stdout.trim() || undefined
  } catch {
    return undefined
  }
}
