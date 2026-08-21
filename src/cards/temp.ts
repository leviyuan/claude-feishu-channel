/**
 * 临时群 / fork / back / rs 恢复 相关卡片。
 *
 *   - turnListCard     fk/bk 的"用户输入列表"卡片(倒序,每条一个按钮)
 *   - resumeListCard   rs 空闲模式的"项目最近 24h 会话"列表
 *   - writeLogCard     bk 回滚后发的"回滚段 Write 记录"卡(代码块,可复制)
 *
 * 和 cards/worktree.ts 同一套 schema 2.0 + column_set + button callback 风格。
 * 按钮的 value.kind 在 daemon.ts handleCardAction 里 dispatch。
 */

export interface TurnListEntry {
  /** 在 feishu.getTurnAnchors() 数组里的 0-based 索引;daemon 据此定位 resumeSessionAt */
  idx: number
  preview: string
  ts: number
}

export interface TempListNotice {
  type: 'info' | 'error'
  content: string
}

export interface TurnListCardOpts {
  projectName: string
  mode: 'fork' | 'back'
  entries: TurnListEntry[]
  notice?: TempListNotice
}

export interface ResumeListEntry {
  /** Claude session_id(transcript 文件名,去 .jsonl);恢复时直接 resume 它 */
  sessionId: string
  /** 首条用户输入(会话主题),从 transcript 提取 */
  preview: string
  ts: number
}

export interface ResumeListCardOpts {
  projectName: string
  entries: ResumeListEntry[]
}

export interface WriteLogEntry {
  /** Write / Edit / NotebookEdit / MultiEdit */
  tool: string
  path: string
  /** content(Write)/ new_string(Edit)/ 摘要;已由调用方截断 */
  body: string
}

export interface WriteLogCardOpts {
  projectName: string
  entries: WriteLogEntry[]
}

export interface SelectionResultCardOpts {
  title: string
  message: string
  ok: boolean
}

const WRITE_BODY_MAX = 800

export function turnListCard(opts: TurnListCardOpts): object {
  const isFork = opts.mode === 'fork'
  const btnText = isFork ? '分叉' : '回滚'
  const kind = isFork ? 'temp_fork_select' : 'temp_back_select'
  const hint = isFork
    ? '💡 选一条「用户输入」→ 从这条**之前**开临时群分叉(原会话不动)'
    : '💡 选一条「用户输入」→ 当前会话回退到这条**之前**(之后的作废,并附 Write 记录)'
  const elements: object[] = []
  if (opts.notice) elements.push({ tag: 'markdown', content: noticeMarkdown(opts.notice) })
  if (!opts.entries.length) {
    elements.push({ tag: 'markdown', content: '_当前会话还没有已完成的 turn,无法分叉/回滚。_' })
  } else {
    elements.push({ tag: 'markdown', content: hint })
    for (const e of opts.entries) {
      elements.push({
        tag: 'column_set',
        columns: [
          {
            tag: 'column',
            width: 'weighted',
            weight: 5,
            elements: [{
              tag: 'markdown',
              content: `**${fmtTime(e.ts)}**\n${inlineCode(e.preview.slice(0, 60) || '(空)')}`,
            }],
          },
          {
            tag: 'column',
            width: 'weighted',
            weight: 1,
            elements: [{
              tag: 'button',
              text: { tag: 'plain_text', content: btnText },
              type: isFork ? 'primary' : 'danger',
              behaviors: [{ type: 'callback', value: { kind, anchorIdx: e.idx } }],
            }],
          },
        ],
      })
    }
  }
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `${isFork ? '🔱 fk 分叉' : '⏪ bk 回滚'} · ${opts.projectName}` },
      template: isFork ? 'turquoise' : 'orange',
    },
    body: { elements },
  }
}

export function resumeListCard(opts: ResumeListCardOpts): object {
  const elements: object[] = []
  if (!opts.entries.length) {
    elements.push({ tag: 'markdown', content: `_项目「${opts.projectName}」最近 24h 没有可恢复的会话。_` })
  } else {
    elements.push({ tag: 'markdown', content: '💡 选一个会话在**当前群**接续(相当于把别处的对话搬到这)' })
    for (const e of opts.entries) {
      elements.push({
        tag: 'column_set',
        columns: [
          {
            tag: 'column',
            width: 'weighted',
            weight: 5,
            elements: [{
              tag: 'markdown',
              content: `**${inlineCode(e.sessionId.slice(0, 8))}** · ${fmtTime(e.ts)}\n${inlineCode(e.preview.slice(0, 60) || '(无摘要)')}`,
            }],
          },
          {
            tag: 'column',
            width: 'weighted',
            weight: 1,
            elements: [{
              tag: 'button',
              text: { tag: 'plain_text', content: '恢复' },
              type: 'primary',
              behaviors: [{ type: 'callback', value: { kind: 'temp_resume_select', sessionId: e.sessionId } }],
            }],
          },
        ],
      })
    }
  }
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `🔁 rs 恢复 · ${opts.projectName}` },
      template: 'purple',
    },
    body: { elements },
  }
}

export function writeLogCard(opts: WriteLogCardOpts): object {
  const code = opts.entries.length === 0
    ? '(回滚段内无 Write 类操作)'
    : opts.entries
      .map(e => {
        const body = e.body.length > WRITE_BODY_MAX ? e.body.slice(0, WRITE_BODY_MAX) + '\n…(截断)' : e.body
        return `${e.path}  (${e.tool})\n${body}`
      })
      .join('\n\n')
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `📋 回滚段 Write 记录 · ${opts.projectName}` },
      template: 'grey',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '回滚段内执行的 Write 类操作如下。点代码块右上角复制 → 编辑 → 重发给回滚后的会话,让它重做你想保留的部分。',
        },
        { tag: 'markdown', content: '```\n' + code + '\n```' },
      ],
    },
  }
}

/** Terminal replacement for one-shot menu/fork/back/resume selection cards.
 * It intentionally contains no callback elements, so a completed source card
 * cannot become actionable again after the short in-memory dedupe TTL. */
export function selectionResultCard(opts: SelectionResultCardOpts): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: opts.title },
      template: opts.ok ? 'green' : 'red',
    },
    body: {
      elements: [{
        tag: 'markdown',
        content: `${opts.ok ? '✅' : '❌'} ${escapeMarkdown(opts.message)}`,
      }],
    },
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function inlineCode(s: string): string {
  return '`' + s.replace(/`/g, '\\`').replace(/\n/g, ' ') + '`'
}

function escapeMarkdown(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function noticeMarkdown(notice: TempListNotice): string {
  const color = notice.type === 'error' ? 'red' : 'grey'
  return notice.content
    .split('\n')
    .map(line => `<font color='${color}'>${line || ' '}</font>`)
    .join('\n')
}

/** 截断 Write/Edit 工具 input → 卡片用的 body 文本(给 writeLogCard 喂数据)。 */
export function writeBodyFromToolInput(tool: string, input: any): string {
  if (!input || typeof input !== 'object') return ''
  if (typeof input.content === 'string') return input.content
  if (typeof input.new_string === 'string') return input.new_string
  if (typeof input.new_source === 'string') return input.new_source  // NotebookEdit
  if (Array.isArray(input.edits)) {
    // MultiEdit:多组 old/new,取所有 new_string 拼接
    return input.edits
      .map((ed: any) => typeof ed?.new_string === 'string' ? ed.new_string : '')
      .filter(Boolean)
      .join('\n---\n')
  }
  return ''
}
