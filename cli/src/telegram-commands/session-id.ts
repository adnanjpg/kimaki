import type { Context } from 'grammy'
import { resolveContext } from './resolve.js'

export async function handleSessionId(ctx: Context): Promise<void> {
  const resolved = await resolveContext(ctx)
  if (!resolved || !resolved.sessionId) {
    await ctx.reply('No active session.')
    return
  }

  await ctx.reply(
    `<b>Session ID:</b> <code>${resolved.sessionId}</code>\n` +
    `<b>Thread ID:</b> <code>${resolved.threadId}</code>`,
    { parse_mode: 'HTML' },
  )
}
