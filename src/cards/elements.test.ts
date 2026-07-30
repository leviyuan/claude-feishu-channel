import { describe, expect, test } from 'bun:test'

import { sanitizeMarkdownForCardKit, downgradeExternalImagesForCardKit } from './elements'

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

  test('图片 url 含空格时保留完整(不截断到空白)', () => {
    const out = sanitizeMarkdownForCardKit('![diagram](https://example.com/my architecture.png)')
    expect(out).not.toMatch(/!\[/)
    expect(out).toContain('https://example.com/my architecture.png')
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
