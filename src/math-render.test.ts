import { describe, expect, test } from 'bun:test'
import { __test, hasMathSpans } from './math-render.ts'

const { findMathSpans, stashNonLatin, renderTeXToPNG } = __test

describe('findMathSpans', () => {
  test('display $$…$$ 与 \\[…\\] 都识别', () => {
    const spans = findMathSpans('前文 $$S=E_{net}$$ 后文 \\[a+b\\]')
    expect(spans.length).toBe(2)
    expect(spans[0].tex).toBe('S=E_{net}')
    expect(spans[0].display).toBe(true)
    expect(spans[1].tex).toBe('a+b')
  })

  test('inline \\(…\\) 识别且 display=false', () => {
    const spans = findMathSpans('评分 \\(S=E\\) 结束')
    expect(spans.length).toBe(1)
    expect(spans[0].display).toBe(false)
  })

  test('裸 $…$ 不识别(防货币误伤)', () => {
    expect(findMathSpans('价格 $5 和 $10')).toHaveLength(0)
  })

  test('代码围栏里的公式不误伤 —— 上层 transformProseOutsideCode 已隔离,此处只保证定位器本身不跨段吞字', () => {
    // findMathSpans 只定位;代码块保护由 sanitize 层负责,这里验证不越界
    const spans = findMathSpans('a \\(x\\) b $$y$$ c')
    expect(spans.map(s => s.tex)).toEqual(['x', 'y'])
  })

  test('空公式跳过', () => {
    expect(findMathSpans('$$$$')).toHaveLength(0)
    expect(findMathSpans('\\(\\)')).toHaveLength(0)
  })
})

describe('hasMathSpans', () => {
  test('快速探测', () => {
    expect(hasMathSpans('无公式正文')).toBe(false)
    expect(hasMathSpans('$$x$$')).toBe(true)
  })
})

describe('stashNonLatin', () => {
  test('CJK 换占位、map 完整', () => {
    const tex = '\\text{' + String.fromCharCode(0x8BC4, 0x5206) + ' }S=E'
    const { src, map } = stashNonLatin(tex)
    expect(src).not.toContain(String.fromCharCode(0x8BC4))
    expect(map.length).toBe(2)
    expect(src).toContain(map[0].ph)
  })

  test('纯 ASCII 不动', () => {
    const { src, map } = stashNonLatin('E=mc^2')
    expect(src).toBe('E=mc^2')
    expect(map).toHaveLength(0)
  })
})

describe('renderTeXToPNG', () => {
  test('用户实例:含 CJK \\text 的评分公式渲染成 PNG', () => {
    const tex = '\\text{' + String.fromCharCode(0x8BC4, 0x5206) + ' }S=E_{\\text{net}}\\times(1+\\beta Q_{\\text{OI}})'
    const r = renderTeXToPNG(tex)
    expect(r).not.toBeNull()
    expect(r!.png.length).toBeGreaterThan(1000) // 非 trivial PNG
    // PNG magic
    expect(r!.png[0]).toBe(0x89)
    expect(String.fromCharCode(r!.png[1], r!.png[2], r!.png[3])).toBe('PNG')
  })

  test('复杂公式:frac/sum/矩阵', () => {
    const r1 = renderTeXToPNG('S=\\sum_{i=1}^{n} w_i \\cdot \\frac{x_i-\\mu}{\\sigma}')
    expect(r1).not.toBeNull()
    const r2 = renderTeXToPNG('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}')
    expect(r2).not.toBeNull()
  })

  test('未知环境名不抛(MathJax 容错渲染 error 文本而非 throw)', () => {
    // MathJax 对未定义环境不 throw,渲染成红色 error mtext —— 返回 PNG 而非 null,
    // 真正的 throw 路径(解析崩溃)才返回 null。
    const r = renderTeXToPNG('\\begin{nope}')
    expect(r).not.toBeNull()
  })
})
