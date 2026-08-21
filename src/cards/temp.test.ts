import { test, expect } from 'bun:test'
import {
  writeBodyFromToolInput,
  turnListCard,
  resumeListCard,
  selectionResultCard,
  writeLogCard,
} from './temp'

test('writeBodyFromToolInput:Write 取 content', () => {
  expect(writeBodyFromToolInput('Write', { file_path: '/a', content: 'hello' })).toBe('hello')
})

test('writeBodyFromToolInput:Edit 取 new_string', () => {
  expect(writeBodyFromToolInput('Edit', { file_path: '/a', old_string: 'x', new_string: 'y' })).toBe('y')
})

test('writeBodyFromToolInput:MultiEdit 拼接所有 new_string', () => {
  expect(writeBodyFromToolInput('MultiEdit', { edits: [{ new_string: 'a' }, { new_string: 'b' }] })).toBe('a\n---\nb')
})

test('writeBodyFromToolInput:无可识别字段返回空串', () => {
  expect(writeBodyFromToolInput('Write', { file_path: '/a' })).toBe('')
  expect(writeBodyFromToolInput('Write', null as any)).toBe('')
})

test('turnListCard:fork 模式生成合法卡片结构 + 按钮 kind', () => {
  const card = turnListCard({
    projectName: 'feishu',
    mode: 'fork',
    entries: [{ idx: 0, preview: '帮我重构', ts: 1700000000000 }],
  }) as any
  expect(card.schema).toBe('2.0')
  expect(card.header.template).toBe('turquoise')
  const btn = card.body.elements.find((e: any) => e.tag === 'column_set')!.columns[1].elements[0]
  expect(btn.text.content).toBe('分叉')
  expect(btn.behaviors[0].value.kind).toBe('temp_fork_select')
  expect(btn.behaviors[0].value.anchorIdx).toBe(0)
})

test('turnListCard:back 模式按钮用 danger + temp_back_select', () => {
  const card = turnListCard({ projectName: 'p', mode: 'back', entries: [{ idx: 2, preview: 'x', ts: 1 }] }) as any
  const btn = card.body.elements.find((e: any) => e.tag === 'column_set')!.columns[1].elements[0]
  expect(btn.type).toBe('danger')
  expect(btn.behaviors[0].value.kind).toBe('temp_back_select')
  expect(card.header.template).toBe('orange')
})

test('turnListCard:无 entries 显示提示,不崩', () => {
  const card = turnListCard({ projectName: 'p', mode: 'fork', entries: [] }) as any
  expect(card.body.elements.some((e: any) => e.tag === 'markdown')).toBe(true)
})

test('resumeListCard:按钮带 sessionId', () => {
  const card = resumeListCard({
    projectName: 'p',
    entries: [{ sessionId: 'abc12345-aaaa-bbbb-cccc-dddddddddddd', preview: '修bug', ts: 1 }],
  }) as any
  const btn = card.body.elements.find((e: any) => e.tag === 'column_set')!.columns[1].elements[0]
  expect(btn.behaviors[0].value).toEqual({ kind: 'temp_resume_select', sessionId: 'abc12345-aaaa-bbbb-cccc-dddddddddddd' })
})

test('selectionResultCard:终态卡不再包含 callback 按钮', () => {
  const card = selectionResultCard({ title: '⏪ 会话回滚', message: '已回滚', ok: true }) as any
  expect(card.config.update_multi).toBe(true)
  expect(card.header.template).toBe('green')
  expect(JSON.stringify(card)).toContain('已回滚')
  expect(JSON.stringify(card)).not.toContain('callback')
})

test('writeLogCard:entries 拼成代码块,空则占位', () => {
  const full = writeLogCard({ projectName: 'p', entries: [{ tool: 'Write', path: '/a', body: 'x' }] }) as any
  const codeEl = full.body.elements.find((e: any) => e.tag === 'markdown' && String(e.content).includes('```'))
  expect(codeEl.content).toContain('/a  (Write)')
  expect(codeEl.content).toContain('x')

  const empty = writeLogCard({ projectName: 'p', entries: [] }) as any
  const emptyCode = empty.body.elements.find((e: any) => String(e.content ?? '').includes('```'))!
  expect(emptyCode.content).toContain('无 Write 类操作')
})

test('writeLogCard:超长 body 截断', () => {
  const long = 'x'.repeat(2000)
  const card = writeLogCard({ projectName: 'p', entries: [{ tool: 'Write', path: '/a', body: long }] }) as any
  const codeEl = card.body.elements.find((e: any) => String(e.content).includes('```'))!
  expect(codeEl.content).toContain('…(截断)')
})
