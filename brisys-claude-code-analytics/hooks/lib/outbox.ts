// 送信待ちの保存 (outbox)。`$.store` はプラグインごとの永続領域で、別プロセスの
// セッションと共有される。キー単位の書き込みは互いを消さない (2 セッション同時に
// 40 キーずつ書いて 80 キー残ることを実測)。そのため 1 件 1 キーで保存する。
//
// 本文は保存後に書き換えない。再送の回数と次の時刻だけを更新する。同じものを 2 つの
// セッションが送っても、API の event_id が同じなので staging で 1 件になる。
//
// `$.store` を読み書きする処理は register.ts にある。ここにはキーと形式の定義だけを置く。

import type { JsonObject } from './types'

export const OUTBOX_PREFIX = 'outbox/v1/'
export const QUARANTINE_PREFIX = 'quarantine/v1/'
export const ORIGIN_PREFIX = 'origin/v1/'
export const STATS_KEY = 'stats/v1'

/** 送信待ちの 1 件。`event` は送る本文の素 (送信元の識別情報は送る直前に足す)。 */
export type OutboxRecord = {
  v: 1
  kind: 'session.started' | 'transcript'
  sessionId: string
  /** 送信元 (project / git remote) を決めるときの cwd */
  cwd: string
  transcriptPath: string
  /** 作った時刻 (ms) */
  createdAt: number
  event: JsonObject
  attempts: number
  /** 次に送ってよい時刻 (ms) */
  nextAt: number
  lastStatus?: number | string
}

export type Stats = { dropped: number; quarantined: number }

export function isOutboxRecord(value: unknown): value is OutboxRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<OutboxRecord>
  return (
    record.v === 1 &&
    (record.kind === 'session.started' || record.kind === 'transcript') &&
    typeof record.sessionId === 'string' &&
    typeof record.cwd === 'string' &&
    typeof record.transcriptPath === 'string' &&
    typeof record.createdAt === 'number' &&
    typeof record.event === 'object' &&
    record.event !== null &&
    typeof record.attempts === 'number' &&
    typeof record.nextAt === 'number'
  )
}

/** 1 件のキー。同じ検出は同じキーになる (transcript 行の uuid とブロックの位置で決まる)。 */
export function recordKey(record: OutboxRecord): string {
  if (record.kind === 'session.started') return `${OUTBOX_PREFIX}${record.sessionId}/session.started`
  const { event_type, transcript_line_uuid, content_index } = record.event
  return `${OUTBOX_PREFIX}${record.sessionId}/${String(event_type)}:${String(transcript_line_uuid)}:${String(content_index ?? 0)}`
}

/**
 * 次に送るまでの待ち時間。retry は 30 秒から倍々で最大 1 時間、hold (401/403) は 1 時間。
 * 同時に失敗した端末が一斉に再送しないよう、±20% の揺らぎを入れる。
 */
export function backoffMs(attempts: number, disposition: 'retry' | 'hold', random: number): number {
  const base = disposition === 'hold' ? 60 * 60_000 : Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 60 * 60_000)
  return Math.round(base * (0.8 + 0.4 * random))
}
