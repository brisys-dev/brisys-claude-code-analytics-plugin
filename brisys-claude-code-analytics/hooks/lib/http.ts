// 送信の組み立てと、応答ごとの扱いの判定。送信そのもの (postJson) は register.ts にある。

/**
 * base の scheme + host に path を継ぎ足す。base にパスが付いていても捨てる
 * (旧 collector の `new URL(path, base)` と同じ。エンドポイントのパスは常にこちらが決める)。
 */
export function joinUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, '')
  const schemeEnd = trimmed.indexOf('://')
  if (schemeEnd >= 0) {
    const slash = trimmed.indexOf('/', schemeEnd + 3)
    if (slash >= 0) return trimmed.slice(0, slash) + path
  }
  return trimmed + path
}

/** ヘッダ値に改行や NUL が混ざっていないか (ヘッダ分割に使えるので送らない)。 */
export function headerValuesAreSafe(...values: string[]): boolean {
  return !values.some((value) => /[\r\n\0]/.test(value))
}

/** `Retry-After` (秒) をミリ秒にする。日付形式は扱わない。 */
export function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const seconds = Number(value.trim())
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

export type PostResult = { kind: 'response'; status: number; retryAfterMs?: number } | { kind: 'error'; reason: string }

/**
 * 応答ごとの扱い。
 * - sent: 2xx。保存したものを消す
 * - retry: 408・429・5xx・通信の失敗。間隔を広げて再送する
 * - hold: 401・403。API キーなど設定の異常なので、長めの間隔で保持する
 * - quarantine: そのほかの 4xx (400・413・422 など)。本文の誤りで送り直しても通らないので隔離する
 */
export function classify(result: PostResult): 'sent' | 'retry' | 'hold' | 'quarantine' {
  if (result.kind === 'error') return 'retry'
  const { status } = result
  if (status >= 200 && status < 300) return 'sent'
  if (status === 408 || status === 429 || status >= 500) return 'retry'
  if (status === 401 || status === 403) return 'hold'
  return 'quarantine'
}
