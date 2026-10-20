// 送信 body の組み立て。API 側 (ai-analytics) の Zod schema と一対一で、旧 collector と同じ形。
// 片方だけ変えると 400 で捨てられる。

import type { JsonObject, Origin } from './types'

/**
 * 秒精度の ISO 8601 (`YYYY-MM-DDTHH:MM:SS.000Z`)。session.started の event_at に使う。
 * API の重複排除キーが秒精度なので、ミリ秒を送っても意味がない (旧 collector と同じ)。
 */
export function secondsIso(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString()
}

/** ミリ秒精度の ISO 8601。transcript 系の event_at に使う (transcript の timestamp と同じ精度)。 */
export function millisIso(ms: number): string {
  return new Date(ms).toISOString()
}

/** 運用の診断用に payload へ載せる値。dbt は payload を読まないので集計には影響しない。 */
export function originDiagnostics(origin: Origin): JsonObject {
  return {
    email_source: origin.emailSource,
    platform: origin.platform,
    git_remote_source: origin.gitRemoteSource,
  }
}

/** `POST /api/v1/events` の session.started。git_remote_url は取れたときだけ入れる (null は送らない)。 */
export function sessionStartedBody(
  sessionId: string,
  eventAt: string,
  origin: Origin,
  payload: JsonObject,
): JsonObject {
  const body: JsonObject = {
    event_type: 'session.started',
    event_at: eventAt,
    session_id: sessionId,
    project: origin.project,
    email: origin.email,
    hostname: origin.hostname,
    collector_version: origin.collectorVersion,
    payload,
  }
  if (origin.gitRemoteUrl) body.git_remote_url = origin.gitRemoteUrl
  return body
}

/** `POST /api/v1/transcript-events` の batch。parser_version は collector_version と同じ値 (旧 collector と同じ)。 */
export function transcriptBatchBody(
  sessionId: string,
  transcriptPath: string,
  origin: Origin,
  events: JsonObject[],
): JsonObject {
  return {
    session_id: sessionId,
    project: origin.project,
    email: origin.email,
    hostname: origin.hostname,
    collector_version: origin.collectorVersion,
    parser_version: origin.collectorVersion,
    transcript_path: transcriptPath,
    events,
  }
}
