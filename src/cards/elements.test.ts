import { describe, expect, test } from 'bun:test'

import {
  sanitizeMarkdownForCardKit,
  downgradeExternalImagesForCardKit,
  neutralizeMarkdownImagesInCard,
} from './elements'

describe('sanitizeMarkdownForCardKit', () => {
  test('降级 prose 里的外链图片,保留 alt + url', () => {
    const out = sanitizeMarkdownForCardKit('看 ![logo](https://res.mail.qq.com/x/y.png) 图')
    expect(out).not.toMatch(/!\[/) // 不残留会被 CardKit 解析成 image 的语法
    expect(out).toContain('https://res.mail.qq.com/x/y.png')
    expect(out).toContain('logo')
  })

  test('alt 为空时只保留 url', () => {
    const out = sanitizeMarkdownForCardKit('前置 ![](https://x/y.png) 后置')
    expect(out).not.toMatch(/!\[/)
    expect(out).toContain('https://x/y.png')
  })

  test('不按字符串外形信任图片 key,占位符和伪造 key 都降级', () => {
    for (const key of ['img_key', 'img_v2_fakeKey123']) {
      const out = sanitizeMarkdownForCardKit(`评分公式:\n\n![formula](${key})\n\n完`)
      expect(out).not.toContain('![formula]')
      expect(out).toContain(key)
    }
  })

  test('代码块内的图片语法原样保留(字面量,不解析也不转义)', () => {
    const src = '```\n![](https://x/y.png)\n```'
    expect(sanitizeMarkdownForCardKit(src)).toBe(src)
  })

  test('行内代码内的图片/特殊字符原样保留', () => {
    expect(sanitizeMarkdownForCardKit('运行 `a & b <c> ![](x)` 命令')).toBe('运行 `a & b <c> ![](x)` 命令')
  })

  test('prose 里的 HTML 特殊字符转义,防被 CardKit 当结构吞', () => {
    expect(sanitizeMarkdownForCardKit('a <b> & c > d')).toBe('a &lt;b&gt; &amp; c &gt; d')
  })

  test('代码块内的 & 与 <> 不被转义(字面量保真)', () => {
    expect(sanitizeMarkdownForCardKit('```\na & b < c > d\n```')).toBe('```\na & b < c > d\n```')
  })

  test('保留合法 markdown:粗体 / 文字链接 / 列表(<> 仍转义,引用块退化为字面 >)', () => {
    const src = '**粗体** [文字](https://x) - 列表项'
    expect(sanitizeMarkdownForCardKit(src)).toBe(src)
    // 行首 > 是引用语法,但 > 属 HTML 特殊字符会被转义 → 引用退化为字面
    // "> ..."(信息保留,仅样式丢失),换来 prose 里 <tag> 不被 CardKit 吞。
    expect(sanitizeMarkdownForCardKit('> 引用')).toBe('&gt; 引用')
  })

  test('文字链接 [text](url) 不被降级(只有 ! 开头的图片才降级)', () => {
    const src = '见 [文档](https://open.feishu.cn/x)'
    expect(sanitizeMarkdownForCardKit(src)).toBe(src)
  })

  test('混合:prose 图片降级,代码块内图片保留', () => {
    const out = sanitizeMarkdownForCardKit('图 ![](https://a/b.png) 代码\n```\n![](https://c/d.png)\n```')
    expect(out).not.toMatch(/!\[\]\(https:\/\/a\//) // prose 的已降级
    expect(out).toContain('🖼️ https://a/b.png')
    expect(out).toContain('![](https://c/d.png)') // 代码块内原样
  })

  test('空串安全', () => {
    expect(sanitizeMarkdownForCardKit('')).toBe('')
  })

  test('4+ 反引号 fence(fenceBlock 包裹含 ``` 的内容)内层 ``` 与 & < > 字面保留', () => {
    // tool.ts 的 fenceBlock 在内容含 ``` 时把 fence 扩到 4+ 反引号;
    // sanitize 必须用「同长反向引用」识别可变 fence,否则会把内层 ```
    // 当边界劈开 fence,把 fence 内的 & < > 当 prose 转义。
    const src = '````\nsee ```a < b & c``` here\n````'
    expect(sanitizeMarkdownForCardKit(src)).toBe(src)
  })

  test('tilde fence 与多反引号 inline code 内的公式保持字面量', () => {
    const src = '~~~tex\n$$x^2$$ & <tag>\n~~~\n``$$y^2$$ & <tag>``'
    expect(sanitizeMarkdownForCardKit(src)).toBe(src)
  })

  test('图片 url 含空格时保留完整(不截断到空白)', () => {
    const out = sanitizeMarkdownForCardKit('![diagram](https://example.com/my architecture.png)')
    expect(out).not.toMatch(/!\[/)
    expect(out).toContain('https://example.com/my architecture.png')
  })

  test('嵌套 alt/url 也不残留可解析的图片 opener', () => {
    for (const src of [
      '![](foo![x](img_key))',
      '![a [b]](img_key)',
    ]) {
      expect(sanitizeMarkdownForCardKit(src)).not.toContain('![')
    }
  })
})

describe('downgradeExternalImagesForCardKit', () => {
  test('降级 prose 外链图片,代码块内图片原样保留', () => {
    const out = downgradeExternalImagesForCardKit('图 ![](https://x/y.png) 代码\n```\n![](https://c/d.png)\n```')
    expect(out).not.toMatch(/!\[\]\(https:\/\/x\//)
    expect(out).toContain('https://x/y.png')
    expect(out).toContain('![](https://c/d.png)')
  })

  test('保留 <font> 等 HTML 标签不转义(供 notify 调用方做彩色)', () => {
    expect(downgradeExternalImagesForCardKit("<font color='red'>构建失败</font>"))
      .toBe("<font color='red'>构建失败</font>")
  })

  test('prose 里的 & < > 不转义(与 sanitizeMarkdownForCardKit 的关键区别)', () => {
    expect(downgradeExternalImagesForCardKit('a < b & c > d')).toBe('a < b & c > d')
  })

  test('代码块内的图片语法与 HTML 标签原样保留(字面)', () => {
    const src = "```\n![](https://x/y.png)\n<font color='red'>x</font>\n```"
    expect(downgradeExternalImagesForCardKit(src)).toBe(src)
  })
})

describe('neutralizeMarkdownImagesInCard', () => {
  test('递归覆盖 plan/goal/task/Ask 等任意 markdown sink,保留结构化图片和 HTML', () => {
    const card = neutralizeMarkdownImagesInCard({
      body: {
        elements: [
          {
            tag: 'collapsible_panel',
            elements: [{ tag: 'markdown', content: "<font color='red'>x</font> ![bad](img_key)" }],
          },
          { tag: 'img', img_key: 'img_v2_uploaded' },
        ],
      },
    }) as any

    const markdown = card.body.elements[0].elements[0].content
    expect(markdown).toContain("<font color='red'>x</font>")
    expect(markdown).not.toContain('![')
    expect(markdown).toContain('img_key')
    expect(card.body.elements[1]).toEqual({ tag: 'img', img_key: 'img_v2_uploaded' })
  })
})

describe('latex downgrade for cardkit markdown', () => {
  test('display math \\[..\] and $$..$$ become code blocks', () => {
    const out = sanitizeMarkdownForCardKit('公式:\n\\[\\text{IM} \\frac{a}{b}\\]\n结束')
    expect(out).toContain('```\n\\text{IM} \\frac{a}{b}\n```')
    const out2 = sanitizeMarkdownForCardKit('$$x^2 + y^2 = r^2$$')
    expect(out2).toContain('```\nx^2 + y^2 = r^2\n```')
  })
  test('inline \\(..\\) becomes inline code; math-flavored $..$ downgraded', () => {
    expect(sanitizeMarkdownForCardKit('\\(a_1 + b_2\\)')).toBe('`a_1 + b_2`')
    expect(sanitizeMarkdownForCardKit('$x = 1$')).toBe('`x = 1`')
  })
  test('plain dollar amounts are not mangled', () => {
    expect(sanitizeMarkdownForCardKit('价格 $5 和 $10')).toBe('价格 $5 和 $10')
  })
})
