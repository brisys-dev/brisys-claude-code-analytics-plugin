// セッションの観測と送信の制御。register.ts のフックから呼ばれる。
//
// 観測したもの (session.started、Skill / コマンドの検出) はすぐ outbox に保存し、
// ターン完了・timer・session.end で送る。送れなかったものは outbox に残り、次の機会に送る。
// どの処理で失敗しても、Claude の操作は止めない (例外は guard で握って debug log に出す)。

import { millisIso, originDiagnostics, secondsIso, sessionStartedBody, transcriptBatchBody } from './body'
import { claudeConfigDir, readConfig } from './config'
import { commandEvent, mayHoldDetection, type Row, skillEvents } from './detect'
import { classify, type PostResult, postJson } from './http'
import { resolveOrigin } from './identity'
import {
  backoffMs,
  bumpStats,
  isOutboxRecord,
  ORIGIN_PREFIX,
  OUTBOX_PREFIX,
  type OutboxRecord,
  persistRecord,
  QUARANTINE_PREFIX,
  readStats,
} from './outbox'
import { deliveryRoute, mainTranscriptPath, subagentTranscriptPath } from './paths'
import type { Config, Dollar, JsonObject, Origin } from './types'

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
export const SESSION_END_DEADLINE_MS = 1500

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
const sessions = new Map<string, SessionInfo>()
const emailBySession = new Map<string, string>()
const agentTypes = new Map<string, string>()
const origins = new Map<string, Origin>()

async function loadConfig($: Dollar): Promise<Config | undefined> {
  if (!configRead) {
    config = await readConfig($)
    configRead = true
  }
  return config
}

/** debug log (`claude --debug`) に書く。失敗は常に、成功は AI_ANALYTICS_DEBUG=1 のときだけ。 */
function log($: Dollar, text: string, always = true): void {
  if (!always && !config?.debug) return
  try {
    $.ui.log(`[analytics] ${text}`, { to: 'debug' })
  } catch {}
}

/** フックの本体を包む。例外は外へ出さず debug log に残す (フックが飛ばされないように)。 */
export async function guard($: Dollar, label: string, work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch (error) {
    log($, `${label} で失敗: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** telemetry.log の属性から、そのセッションのアカウント (OTEL と同じ値) を覚える。 */
export function rememberTelemetry(attributes: Readonly<Record<string, unknown>>): void {
  const email = attributes['user.email']
  const sessionId = attributes['session.id']
  if (typeof email === 'string' && email && typeof sessionId === 'string' && sessionId) {
    emailBySession.set(sessionId, email)
  }
}

/** agent.spawn で分かったサブエージェントの種類を覚える。 */
export function rememberAgentType(agentId: string, agentType: string): void {
  agentTypes.set(agentId, agentType)
}

function startTimer($: Dollar): void {
  if (timerStarted) return
  timerStarted = true
  $.clock.after(FIRST_FLUSH_DELAY_MS, () => void deliver($))
  $.clock.every(FLUSH_INTERVAL_MS, () => void deliver($))
}

/** session.start: 起動・再開したセッションを記録し、送信の timer を始める。 */
export async function onSessionStart($: Dollar, cwd: string): Promise<void> {
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
export async function onMainTurnStart($: Dollar): Promise<void> {
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
    delivery: deliveryRoute($.plugin.root),
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
export async function onRow($: Dollar, row: Row, uuid: string, agentId: string | undefined): Promise<void> {
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
export async function onSessionEnd($: Dollar, sessionId: string, reason: string): Promise<void> {
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

/** outbox を送る。すでに送っている最中なら、その完了を待つ。 */
export function deliver($: Dollar): Promise<void> {
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
    if (!isOutboxRecord(record)) {
      // 知らない形式 (将来の版など) は消さない
      continue
    }
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
