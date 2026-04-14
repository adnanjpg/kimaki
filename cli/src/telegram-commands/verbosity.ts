import type { Context } from 'grammy'
import { resolveContext } from './resolve.js'
import { setChannelVerbosity, getChannelVerbosity } from '../database.js'

const LEVELS = {
  tools_and_text: 'Show all tool calls and text output',
  text_and_essential_tools: 'Show text and essential tools (edit, write, bash)',
  text_only: 'Show only text output',
} as const

type VerbosityLevel = keyof typeof LEVELS

export async function handleVerbosity(ctx: Context): Promise<void> {
  const resolved = await resolveContext(ctx)
  if (!resolved) return

  const args = (ctx.message?.text || '').replace(/^\/verbosity\s*/i, '').trim()

  if (args && args in LEVELS) {
    await setChannelVerbosity(resolved.channelId, args as VerbosityLevel)
    await ctx.reply(
      `Verbosity set to <code>${args}</code>\n${LEVELS[args as VerbosityLevel]}\nApplies immediately, including active sessions.`,
      { parse_mode: 'HTML' },
    )
    return
  }

  const current = await getChannelVerbosity(resolved.channelId)

  // Show options as inline keyboard
  const buttons = Object.entries(LEVELS).map(([key, desc]) => [{
    text: `${key === current ? '✓ ' : ''}${key}`,
    callback_data: `verbosity:${key}`.slice(0, 64),
  }])

  await ctx.reply(`Current verbosity: <code>${current || 'tools_and_text'}</code>\nSelect a level:`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  })
}

export async function handleVerbosityCallback(ctx: Context, data: string): Promise<void> {
  const level = data.replace('verbosity:', '') as VerbosityLevel
  if (!(level in LEVELS)) {
    await ctx.answerCallbackQuery({ text: 'Invalid level' })
    return
  }

  const chatId = ctx.callbackQuery?.message?.chat.id
  if (!chatId) {
    await ctx.answerCallbackQuery({ text: 'Error' })
    return
  }

  const { composeTelegramChannelId } = await import('../telegram-utils.js')
  const channelId = composeTelegramChannelId(chatId)

  await setChannelVerbosity(channelId, level)
  await ctx.answerCallbackQuery({ text: `Verbosity: ${level}` })
  await ctx.editMessageText(
    `Verbosity set to <code>${level}</code>\n${LEVELS[level]}`,
    { parse_mode: 'HTML' },
  ).catch(() => {})
}
