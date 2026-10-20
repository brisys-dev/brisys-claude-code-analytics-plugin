// Claude Code の利用統計を集めて ai-analytics の API へ送る mod。
//
// 旧 collector (Rust バイナリの command hook) と同じ body を送る:
//   - session.started            -> POST /api/v1/events
//   - Skill / スラッシュコマンド   -> POST /api/v1/transcript-events
// 送信先とキーは managed settings の env (AI_ANALYTICS_API_URL / AI_ANALYTICS_API_KEY) で配られ、
// 無ければ何もしない。
//
// GitHub のマーケットプレイスや claude.ai の組織同期から入る mod は「ユーザー扱い」で、
// managed settings のある端末では組込みガード (cc-plugin-sec-default) が classic.* を渡さない。
// そのため従来の hook 入力 (classic.SessionStart など) は使わず、届くイベントだけで組んでいる。

import type { Register } from 'claude-code'
import {
  deliver,
  guard,
  onMainTurnStart,
  onRow,
  onSessionEnd,
  onSessionStart,
  rememberAgentType,
  rememberTelemetry,
} from './lib/collector'

export const register: Register = (on) => {
  // エンジンのテレメトリから、セッションの実際のアカウントを覚える (OTEL の user.email と同じ値)
  on('telemetry.log', { to: 'collector' }, async (_$, e, next) => {
    if (e.to === 'collector') rememberTelemetry(e.attributes)
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await guard($, 'session.start', () => onSessionStart($, e.cwd))
    return result
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await guard($, 'turn.start', () => onMainTurnStart($))
    return result
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (stored.deny === undefined) {
      await guard($, 'session.append', () => onRow($, stored.message, stored.uuid, e.agentId))
    }
    return stored
  })

  on('agent.spawn', async (_$, e, next) => {
    const result = await next(e)
    if (result.deny === undefined && result.agentId) rememberAgentType(result.agentId, e.subagentType)
    return result
  })

  // ターンの完了を待たせないよう、送信は待たずに返す
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void deliver($)
    return result
  })

  on('session.end', async ($, e, next) => {
    await guard($, 'session.end', () => onSessionEnd($, e.sessionId, e.reason))
    return next(e)
  })
}
