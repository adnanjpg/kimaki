// Telegram message formatting — converts markdown to Telegram HTML.
//
// Telegram supports two parse modes: MarkdownV2 (fragile, many escape chars)
// and HTML (robust, well-defined). We use HTML because AI-generated markdown
// contains characters like . - ( ) ! that MarkdownV2 requires escaping.
//
// Reference: https://core.telegram.org/bots/api#html-style

import { Lexer, type Token, type Tokens } from 'marked'

const TELEGRAM_MAX_LENGTH = 4096

// ── HTML entity escaping ─────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// ── Inline token → HTML ──────────────────────────────────────────

function renderInlineTokens(tokens: Token[]): string {
  let result = ''
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        result += escapeHtml(token.text)
        break
      case 'strong':
        result += `<b>${renderInlineTokens((token as Tokens.Strong).tokens)}</b>`
        break
      case 'em':
        result += `<i>${renderInlineTokens((token as Tokens.Em).tokens)}</i>`
        break
      case 'del':
        result += `<s>${renderInlineTokens((token as Tokens.Del).tokens)}</s>`
        break
      case 'codespan':
        result += `<code>${escapeHtml((token as Tokens.Codespan).text)}</code>`
        break
      case 'link': {
        const link = token as Tokens.Link
        const linkText = renderInlineTokens(link.tokens)
        result += `<a href="${escapeHtml(link.href)}">${linkText}</a>`
        break
      }
      case 'image': {
        const img = token as Tokens.Image
        result += `[${escapeHtml(img.text || 'image')}](${escapeHtml(img.href)})`
        break
      }
      case 'br':
        result += '\n'
        break
      case 'escape':
        result += escapeHtml((token as Tokens.Escape).text)
        break
      default:
        // For any unrecognized inline token, output raw text if available
        if ('text' in token && typeof token.text === 'string') {
          result += escapeHtml(token.text)
        } else if ('raw' in token && typeof token.raw === 'string') {
          result += escapeHtml(token.raw)
        }
        break
    }
  }
  return result
}

// ── Block token → HTML ───────────────────────────────────────────

function renderToken(token: Token): string {
  switch (token.type) {
    case 'heading': {
      const heading = token as Tokens.Heading
      // Telegram has no heading element — render as bold
      return `<b>${renderInlineTokens(heading.tokens)}</b>\n\n`
    }

    case 'paragraph': {
      const para = token as Tokens.Paragraph
      return `${renderInlineTokens(para.tokens)}\n\n`
    }

    case 'code': {
      const code = token as Tokens.Code
      const lang = code.lang ? ` class="language-${escapeHtml(code.lang)}"` : ''
      return `<pre><code${lang}>${escapeHtml(code.text)}</code></pre>\n\n`
    }

    case 'blockquote': {
      const bq = token as Tokens.Blockquote
      // Telegram supports <blockquote> in HTML parse mode
      const inner = bq.tokens.map(renderToken).join('')
      return `<blockquote>${inner.trimEnd()}</blockquote>\n\n`
    }

    case 'list': {
      const list = token as Tokens.List
      const lines: string[] = []
      for (let i = 0; i < list.items.length; i++) {
        const item = list.items[i]!
        const prefix = list.ordered ? `${(list.start || 1) + i}. ` : '• '
        const content = item.tokens.map(renderToken).join('').trimEnd()
        lines.push(`${prefix}${content}`)
      }
      return lines.join('\n') + '\n\n'
    }

    case 'table': {
      const table = token as Tokens.Table
      return renderTableAsAscii(table)
    }

    case 'hr':
      return '───────────────\n\n'

    case 'space':
      return '\n'

    case 'html': {
      // Pass through raw HTML (may not render in Telegram, but best effort)
      const html = token as Tokens.HTML
      return html.text
    }

    default: {
      // Inline content at block level
      if ('tokens' in token && Array.isArray(token.tokens)) {
        return renderInlineTokens(token.tokens)
      }
      if ('text' in token && typeof token.text === 'string') {
        return escapeHtml(token.text)
      }
      if ('raw' in token && typeof token.raw === 'string') {
        return escapeHtml(token.raw)
      }
      return ''
    }
  }
}

// ── GFM table → ASCII in <pre> ───────────────────────────────────

function renderTableAsAscii(table: Tokens.Table): string {
  const headers = table.header.map((cell) => {
    return renderInlineTokens(cell.tokens).replace(/<[^>]+>/g, '')
  })
  const rows = table.rows.map((row) => {
    return row.map((cell) => {
      return renderInlineTokens(cell.tokens).replace(/<[^>]+>/g, '')
    })
  })

  // Calculate column widths
  const colCount = headers.length
  const widths: number[] = []
  for (let c = 0; c < colCount; c++) {
    let max = (headers[c] || '').length
    for (const row of rows) {
      max = Math.max(max, (row[c] || '').length)
    }
    widths.push(max)
  }

  function padCell(text: string, colIdx: number): string {
    const w = widths[colIdx] || 0
    return text.padEnd(w)
  }

  const headerLine = headers.map((h, i) => padCell(h, i)).join(' │ ')
  const separatorLine = widths.map((w) => '─'.repeat(w)).join('─┼─')
  const dataLines = rows.map((row) => {
    return row.map((cell, i) => padCell(cell, i)).join(' │ ')
  })

  const ascii = [headerLine, separatorLine, ...dataLines].join('\n')
  return `<pre>${escapeHtml(ascii)}</pre>\n\n`
}

// ── Main conversion function ─────────────────────────────────────

/**
 * Convert markdown to Telegram HTML format.
 *
 * Handles: bold, italic, strikethrough, code, code blocks, links,
 * headings (as bold), blockquotes, lists, GFM tables (as ASCII pre),
 * horizontal rules.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const lexer = new Lexer()
  const tokens = lexer.lex(markdown)

  let html = ''
  for (const token of tokens) {
    html += renderToken(token)
  }

  // Clean up excessive whitespace
  return html.replace(/\n{3,}/g, '\n\n').trimEnd()
}

// ── Message splitting ────────────────────────────────────────────

/**
 * Split a Telegram HTML message into chunks that fit within the 4096 char limit.
 * Tries to split at paragraph boundaries (\n\n), then line boundaries (\n),
 * then falls back to hard truncation.
 *
 * Preserves HTML tag integrity — never splits inside a tag.
 */
export function splitTelegramMessage(
  html: string,
  maxLength: number = TELEGRAM_MAX_LENGTH,
): string[] {
  if (html.length <= maxLength) {
    return [html]
  }

  const chunks: string[] = []
  let remaining = html

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining)
      break
    }

    // Try to split at paragraph boundary
    let splitIdx = remaining.lastIndexOf('\n\n', maxLength)

    // Fall back to line boundary
    if (splitIdx <= 0 || splitIdx < maxLength * 0.3) {
      splitIdx = remaining.lastIndexOf('\n', maxLength)
    }

    // Fall back to last space before a tag, to avoid splitting inside tags
    if (splitIdx <= 0 || splitIdx < maxLength * 0.3) {
      // Find the last safe split point (not inside an HTML tag)
      splitIdx = findSafeHtmlSplitPoint(remaining, maxLength)
    }

    // Hard truncation as last resort
    if (splitIdx <= 0) {
      splitIdx = maxLength
    }

    chunks.push(remaining.slice(0, splitIdx).trimEnd())
    remaining = remaining.slice(splitIdx).trimStart()
  }

  return chunks.filter((c) => c.length > 0)
}

/**
 * Find a safe split point that doesn't break HTML tags.
 * Scans backwards from maxLength looking for a position outside any tag.
 */
function findSafeHtmlSplitPoint(html: string, maxLength: number): number {
  // Check if we're inside an HTML tag at maxLength
  let inTag = false
  let lastSafePos = 0

  for (let i = 0; i < maxLength && i < html.length; i++) {
    if (html[i] === '<') {
      inTag = true
    } else if (html[i] === '>') {
      inTag = false
      lastSafePos = i + 1
    } else if (!inTag && (html[i] === ' ' || html[i] === '\n')) {
      lastSafePos = i
    }
  }

  return lastSafePos > 0 ? lastSafePos : maxLength
}

// ── Convenience ──────────────────────────────────────────────────

/**
 * Full pipeline: markdown → Telegram HTML → split into sendable chunks.
 */
export function formatForTelegram(markdown: string): string[] {
  const html = markdownToTelegramHtml(markdown)
  return splitTelegramMessage(html)
}
