// TelegramThread — implements PlatformThread for Telegram forum topics.
//
// Each instance wraps a grammy Api handle, a chat ID (supergroup), and a
// topic ID (message_thread_id). The runtime calls send/edit/typing/setName
// and this class translates to Telegram Bot API calls.

import { InputFile, type Api, type RawApi } from 'grammy'

// Telegram inline keyboard types (defined locally to avoid depending on
// @grammyjs/types which may not be hoisted in pnpm strict mode)
type InlineKeyboardButton = { text: string; callback_data: string }
type InlineKeyboardMarkup = { inline_keyboard: InlineKeyboardButton[][] }
import { formatForTelegram, markdownToTelegramHtml } from './telegram-formatting.js'
import type {
  PlatformThread,
  SendOptions,
  EditOptions,
  SendResult,
  PlatformButton,
  PlatformSelectMenu,
} from './types.js'

export type TelegramThreadOptions = {
  api: Api<RawApi>
  chatId: number | string
  topicId: number
  /** Display name for the topic (cached at creation time). */
  topicName: string
  /** Chat ID of the parent supergroup. Also used as serverId. */
  serverId: string
  /** Description/bio of the supergroup (used as channel topic). */
  chatDescription?: string
}

export class TelegramThread implements PlatformThread {
  readonly platform = 'telegram' as const
  readonly id: string
  private _name: string
  readonly parentChannelId: string | undefined
  readonly serverId: string
  readonly createdTimestamp: number | null

  private readonly api: Api<RawApi>
  private readonly chatId: number | string
  private readonly topicId: number
  private readonly chatDescription?: string

  /** Only include message_thread_id in API calls when topicId > 0 (real forum topic). */
  private get threadIdParam(): { message_thread_id: number } | {} {
    return this.topicId > 0 ? { message_thread_id: this.topicId } : {}
  }

  constructor(opts: TelegramThreadOptions) {
    this.api = opts.api
    this.chatId = opts.chatId
    this.topicId = opts.topicId
    this._name = opts.topicName
    this.serverId = opts.serverId
    this.parentChannelId = String(opts.chatId)
    this.createdTimestamp = Date.now()
    this.chatDescription = opts.chatDescription

    // Thread ID format: "tg:{chatId}:{topicId}" — never collides with Discord snowflakes
    this.id = `tg:${opts.chatId}:${opts.topicId}`
  }

  get name(): string {
    return this._name
  }

  async send(content: string, options?: SendOptions): Promise<SendResult> {
    const chunks = formatForTelegram(content)
    let firstMessageId: number | undefined
    // When a keyboard is attached, track its message ID so callers can edit it later.
    let keyboardMessageId: number | undefined

    // Build inline keyboard from buttons/select menus (if any)
    const keyboard = buildInlineKeyboard(options?.buttons, options?.selectMenus)

    // Send content chunks — attach keyboard to the last chunk so buttons
    // appear directly below the message text in a single Telegram message.
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1
      const result = await this.api.sendMessage(this.chatId, chunks[i], {
        ...this.threadIdParam,
        parse_mode: 'HTML',
        disable_notification: options?.flags !== 'notify',
        ...(isLast && keyboard ? { reply_markup: keyboard } : {}),
      })
      if (!firstMessageId) {
        firstMessageId = result.message_id
      }
      if (isLast && keyboard) {
        keyboardMessageId = result.message_id
      }
    }

    // If there were no content chunks but we have a keyboard, send it with
    // the raw content converted to HTML.
    if (chunks.length === 0 && keyboard) {
      const fallbackContent = markdownToTelegramHtml(content) || 'Action required'
      const result = await this.api.sendMessage(this.chatId, fallbackContent, {
        ...this.threadIdParam,
        parse_mode: 'HTML',
        reply_markup: keyboard,
        disable_notification: options?.flags !== 'notify',
      })
      if (!firstMessageId) {
        firstMessageId = result.message_id
      }
      keyboardMessageId = result.message_id
    }

    // Handle file uploads
    if (options?.files?.length) {
      for (const file of options.files) {
        await this.api.sendDocument(this.chatId, new InputFile(file.data, file.filename), {
          ...this.threadIdParam,
          disable_notification: true,
        })
      }
    }

    // Return the keyboard message ID when present — callers (e.g. permission
    // handler) need to edit the message that holds the inline keyboard.
    return { id: String(keyboardMessageId || firstMessageId || 0) }
  }

  async edit(messageId: string, options: EditOptions): Promise<void> {
    const numericId = parseInt(messageId, 10)
    if (!Number.isFinite(numericId)) {
      return
    }

    const html = markdownToTelegramHtml(options.content)
    // Telegram editMessageText max is also 4096. Truncate if needed.
    const truncated = html.length > 4096 ? html.slice(0, 4090) + '...' : html

    await this.api.editMessageText(this.chatId, numericId, truncated, {
      parse_mode: 'HTML',
      // Clear inline keyboard if clearComponents is true (default)
      ...(options.clearComponents !== false ? { reply_markup: { inline_keyboard: [] } } : {}),
    }).catch(() => {
      // Telegram throws if message content hasn't changed — safe to ignore
    })
  }

  async sendTyping(): Promise<void> {
    await this.api.sendChatAction(this.chatId, 'typing', {
      ...this.threadIdParam,
    }).catch(() => {
      // Typing indicator failures are non-critical
    })
  }

  async setName(name: string): Promise<void> {
    await this.api.editForumTopic(this.chatId, this.topicId, {
      name: name.slice(0, 128), // Telegram forum topic name max: 128 chars
    }).catch(() => {
      // Topic rename failures are non-critical (rate limits, permissions)
    })
    this._name = name
  }

  async getParentTopic(_channelId?: string): Promise<string | undefined> {
    // Return the cached chat description as the "channel topic" equivalent
    return this.chatDescription
  }
}

// ── Inline keyboard construction ─────────────────────────────────

function buildInlineKeyboard(
  buttons?: PlatformButton[],
  selectMenus?: PlatformSelectMenu[],
): InlineKeyboardMarkup | undefined {
  const rows: InlineKeyboardButton[][] = []

  if (buttons?.length) {
    // Telegram inline buttons are arranged in rows.
    // Put all buttons in one row (up to Telegram's limit of 8 per row).
    const row: InlineKeyboardButton[] = buttons.map((btn) => ({
      text: btn.label,
      callback_data: btn.customId.slice(0, 64), // Telegram max: 64 bytes
    }))
    rows.push(row)
  }

  if (selectMenus?.length) {
    // Telegram has no native select menus. Render each option as a button.
    for (const menu of selectMenus) {
      for (const opt of menu.options) {
        rows.push([{
          text: opt.label,
          callback_data: `${menu.customId}:${opt.value}`.slice(0, 64),
        }])
      }
    }
  }

  if (rows.length === 0) {
    return undefined
  }

  return { inline_keyboard: rows }
}

// ── Helpers ──────────────────────────────────────────────────────


