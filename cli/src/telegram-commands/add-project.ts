import type { Context } from 'grammy'
import fs from 'node:fs'
import path from 'node:path'
import { composeTelegramChannelId } from '../telegram-utils.js'
import { setChannelDirectory } from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'

export async function handleAddProject(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) {
    await ctx.reply('Cannot determine chat ID.')
    return
  }

  const directory = (ctx.message?.text || '').replace(/^\/addproject\s*/i, '').trim()
  if (!directory) {
    await ctx.reply(
      'Usage: /addproject <path>\n' +
      'Example: /addproject /home/user/myproject\n\n' +
      'Binds this chat to a project directory so messages start OpenCode sessions in that directory.',
    )
    return
  }

  const resolved = path.resolve(directory)
  if (!fs.existsSync(resolved)) {
    await ctx.reply(`Directory does not exist: ${resolved}`)
    return
  }

  const channelId = composeTelegramChannelId(chatId)
  await setChannelDirectory({ channelId, directory: resolved, channelType: 'text' })

  // Try to initialize OpenCode for the directory
  const result = await initializeOpencodeForDirectory(resolved)
  const status = result instanceof Error
    ? `\n⚠️ OpenCode not ready: ${result.message}`
    : '\n✅ OpenCode connected'

  await ctx.reply(
    `Project bound to this chat:\n` +
    `<code>${resolved}</code>${status}`,
    { parse_mode: 'HTML' },
  )
}
