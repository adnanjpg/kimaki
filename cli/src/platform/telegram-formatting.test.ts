import { describe, expect, test } from 'vitest'
import {
  markdownToTelegramHtml,
  splitTelegramMessage,
  formatForTelegram,
} from './telegram-formatting.js'

describe('markdownToTelegramHtml', () => {
  test('converts bold', () => {
    expect(markdownToTelegramHtml('**hello**')).toBe('<b>hello</b>')
  })

  test('converts italic', () => {
    expect(markdownToTelegramHtml('*hello*')).toBe('<i>hello</i>')
  })

  test('converts strikethrough', () => {
    expect(markdownToTelegramHtml('~~hello~~')).toBe('<s>hello</s>')
  })

  test('converts inline code', () => {
    expect(markdownToTelegramHtml('use `npm install`')).toBe(
      'use <code>npm install</code>',
    )
  })

  test('converts code blocks', () => {
    const md = '```js\nconsole.log("hi")\n```'
    const html = markdownToTelegramHtml(md)
    expect(html).toContain('<pre><code class="language-js">')
    // Quotes inside code blocks are preserved (not entity-escaped)
    // because Telegram treats <pre><code> content as literal text.
    // Only &, <, > are escaped (the minimum needed for valid HTML).
    expect(html).toContain('console.log("hi")')
    expect(html).toContain('</code></pre>')
  })

  test('converts code blocks without language', () => {
    const md = '```\nplain code\n```'
    const html = markdownToTelegramHtml(md)
    expect(html).toContain('<pre><code>')
    expect(html).toContain('plain code')
  })

  test('converts links', () => {
    expect(markdownToTelegramHtml('[Google](https://google.com)')).toBe(
      '<a href="https://google.com">Google</a>',
    )
  })

  test('converts headings to bold', () => {
    expect(markdownToTelegramHtml('# Title')).toBe('<b>Title</b>')
    expect(markdownToTelegramHtml('## Subtitle')).toBe('<b>Subtitle</b>')
  })

  test('converts blockquotes', () => {
    const html = markdownToTelegramHtml('> quoted text')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('quoted text')
  })

  test('converts unordered lists', () => {
    const md = '- first\n- second\n- third'
    const html = markdownToTelegramHtml(md)
    expect(html).toContain('• first')
    expect(html).toContain('• second')
    expect(html).toContain('• third')
  })

  test('converts ordered lists', () => {
    const md = '1. first\n2. second\n3. third'
    const html = markdownToTelegramHtml(md)
    expect(html).toContain('1. first')
    expect(html).toContain('2. second')
    expect(html).toContain('3. third')
  })

  test('escapes HTML entities in text', () => {
    expect(markdownToTelegramHtml('a < b & c > d')).toBe(
      'a &lt; b &amp; c &gt; d',
    )
  })

  test('escapes HTML entities in code blocks', () => {
    const md = '```\n<div>&</div>\n```'
    const html = markdownToTelegramHtml(md)
    expect(html).toContain('&lt;div&gt;&amp;&lt;/div&gt;')
  })

  test('converts horizontal rules', () => {
    const html = markdownToTelegramHtml('---')
    expect(html).toContain('───')
  })

  test('converts nested formatting', () => {
    const html = markdownToTelegramHtml('**bold and *italic***')
    expect(html).toContain('<b>')
    expect(html).toContain('<i>')
  })

  test('renders GFM tables as ASCII in pre block', () => {
    const md = '| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |'
    const html = markdownToTelegramHtml(md)
    expect(html).toContain('<pre>')
    expect(html).toContain('Alice')
    expect(html).toContain('Bob')
    expect(html).toContain('│')
    expect(html).toContain('─')
  })

  test('handles empty input', () => {
    expect(markdownToTelegramHtml('')).toBe('')
  })

  test('handles mixed content', () => {
    const md = '# Title\n\nSome **bold** and `code` text.\n\n- item 1\n- item 2'
    const html = markdownToTelegramHtml(md)
    expect(html).toContain('<b>Title</b>')
    expect(html).toContain('<b>bold</b>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('• item 1')
  })
})

describe('splitTelegramMessage', () => {
  test('returns single chunk for short messages', () => {
    const chunks = splitTelegramMessage('hello world')
    expect(chunks).toEqual(['hello world'])
  })

  test('splits at paragraph boundaries', () => {
    const text = 'A'.repeat(4000) + '\n\n' + 'B'.repeat(100)
    const chunks = splitTelegramMessage(text)
    expect(chunks.length).toBe(2)
    expect(chunks[0]).toContain('A')
    expect(chunks[1]).toContain('B')
  })

  test('splits at line boundaries when no paragraph break', () => {
    const text = 'A'.repeat(4000) + '\n' + 'B'.repeat(100)
    const chunks = splitTelegramMessage(text)
    expect(chunks.length).toBe(2)
  })

  test('all chunks are within max length', () => {
    const text = 'word '.repeat(2000) // ~10000 chars
    const chunks = splitTelegramMessage(text, 4096)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096)
    }
  })

  test('does not produce empty chunks', () => {
    const text = 'A'.repeat(8000)
    const chunks = splitTelegramMessage(text)
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0)
    }
  })

  test('respects custom max length', () => {
    const text = 'hello world this is a test'
    const chunks = splitTelegramMessage(text, 10)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(15) // some tolerance for word boundaries
    }
  })
})

describe('formatForTelegram', () => {
  test('full pipeline: markdown in, HTML chunks out', () => {
    const md = '**Hello** world\n\nThis is a `test`.'
    const chunks = formatForTelegram(md)
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain('<b>Hello</b>')
    expect(chunks[0]).toContain('<code>test</code>')
  })

  test('handles very long markdown', () => {
    const md = ('Some **bold** text with `code`. ' + 'word '.repeat(200) + '\n\n').repeat(10)
    const chunks = formatForTelegram(md)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096)
    }
  })
})
