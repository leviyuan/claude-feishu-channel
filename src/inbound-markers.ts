/**
 * 入站多条消息标记解析。
 *
 * 用户在飞书里把一条长消息拆成多条发送时,用前缀标记包围:
 *   - 以 ≥3 个 `>` 开头  → 开始收集(本条及后续都缓冲,不立即送 agent)
 *   - 以 ≥3 个 `<` 开头  → 收尾,把缓冲合并成一条发给 agent
 * 标记前缀本身从 body 里去掉,不转发给 agent。中间不含标记的普通
 * 消息按原样进缓冲(由 session-multimsg.ts 负责)。
 *
 * 跟 outbound-markers.ts 对称:那一头解析 agent 输出里的 [[send:]]
 * 标记,这一头解析用户输入里的 >>>/<<< 标记。阈值 ≥3 是
 * 用户确认的本意(2026-07-02):普通 markdown 引用 `>` / `>>` 不会误触发,
 * 但 `>>>` 三级嵌套引用会——可接受,用户明确要 ≥3。
 */

export type InboundMarker = 'start' | 'end' | 'none'

/** ≥3 个 `>`,吃掉紧随的一个可选空格/tab。无 g flag → 只匹配开头一处。*/
const START_RE = /^>{3,}[ \t]?/
/** ≥3 个 `<`,同理。*/
const END_RE = /^<{3,}[ \t]?/

export interface ParsedInboundMarker {
  marker: InboundMarker
  /** 去掉开头标记(及紧随的一个空白)后的剩余正文;
   *  marker === 'none' 时为原 text 不变。*/
  body: string
}

/** 判断一条入站消息是否以多条消息起始/收尾标记开头,并返回去标记后的正文。*/
export function parseInboundMarker(text: string): ParsedInboundMarker {
  if (START_RE.test(text)) return { marker: 'start', body: text.replace(START_RE, '') }
  if (END_RE.test(text)) return { marker: 'end', body: text.replace(END_RE, '') }
  return { marker: 'none', body: text }
}
