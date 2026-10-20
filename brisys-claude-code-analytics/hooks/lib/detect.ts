// 会話の行 (session.append の row) からスラッシュコマンドと Skill の実行を取り出す。
// 旧 collector が SessionEnd で transcript (JSONL) から抽出していた規則 (transcript.rs) と同じ。
// 送るのは名前と引数の有無だけで、引数の内容は送らない。

import type { JsonObject } from './types'

/** session.append の row のうち、判定に使う部分。 */
export type Row = { type: string; name?: string; content: unknown }

type Block = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function blocks(row: Row): Block[] {
  return Array.isArray(row.content) ? row.content.filter(isRecord) : []
}

/** `<tag>…</tag>` の中身。最初の開始タグから最初の終了タグまで (終了タグが無ければ残り全部)。 */
export function extractTag(text: string, tag: string): string | undefined {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const start = text.indexOf(open)
  if (start < 0) return undefined
  const after = text.slice(start + open.length)
  const end = after.indexOf(close)
  return (end < 0 ? after : after.slice(0, end)).trim()
}

/** 行の本文。文字列ならそれ、text ブロックがちょうど 1 つならその text。 */
export function rowText(row: Row): string | undefined {
  if (typeof row.content === 'string') return row.content
  const texts = blocks(row)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
  return texts.length === 1 ? texts[0] : undefined
}

function isSkillToolUse(block: Block): boolean {
  return block.type === 'tool_use' && block.name === 'Skill'
}

/** 検出の候補になる行か (`$` を呼ぶ前の安い判定)。 */
export function mayHoldDetection(row: Row): boolean {
  if (row.type === 'assistant') return blocks(row).some(isSkillToolUse)
  if (row.type === 'user' || row.type === 'system') return rowText(row)?.includes('<command-name>') ?? false
  return false
}

/** スラッシュコマンドの実行を 1 件取り出す。対象はユーザーの行と、ローカルコマンドの記録 (system / local_command)。 */
export function commandEvent(row: Row, uuid: string, eventAt: string): JsonObject | undefined {
  const isCommandRow = row.type === 'user' || (row.type === 'system' && row.name === 'local_command')
  if (!isCommandRow) return undefined
  const text = rowText(row)
  if (text === undefined) return undefined
  const rawName = extractTag(text, 'command-name')
  if (!rawName) return undefined
  const name = rawName.replace(/^\/+/, '').trim()
  if (!name) return undefined
  const args = extractTag(text, 'command-args') ?? ''
  return {
    event_type: 'transcript.command_detected',
    event_at: eventAt,
    transcript_line_number: null,
    transcript_line_uuid: uuid,
    content_index: null,
    source_record_type: row.type,
    source_record_subtype: row.type === 'system' ? (row.name ?? null) : null,
    payload: {
      command_name: name,
      raw_command_name: rawName,
      has_args: args.trim() !== '',
      // 引数の内容は送らないことを受信側に明示する
      args_redacted: true,
    },
  }
}

/** Skill ツールの呼び出しを取り出す (1 行に複数ありうる)。content_index はブロックの位置。 */
export function skillEvents(row: Row, uuid: string, eventAt: string): JsonObject[] {
  if (row.type !== 'assistant') return []
  const events: JsonObject[] = []
  blocks(row).forEach((block, index) => {
    if (!isSkillToolUse(block)) return
    const input = isRecord(block.input) ? block.input : {}
    const toolUseId = block.id
    const skill = input.skill
    if (typeof toolUseId !== 'string' || !toolUseId || typeof skill !== 'string' || !skill) return
    const caller = isRecord(block.caller) ? block.caller.type : undefined
    events.push({
      event_type: 'transcript.skill_detected',
      event_at: eventAt,
      transcript_line_number: null,
      transcript_line_uuid: uuid,
      content_index: index,
      source_record_type: row.type,
      source_record_subtype: null,
      payload: {
        skill_name: skill,
        tool_use_id: toolUseId,
        caller_type: caller ?? null,
        has_args: typeof input.args === 'string' && input.args !== '',
        args_redacted: true,
      },
    })
  })
  return events
}
