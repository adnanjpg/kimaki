import type { Context } from 'grammy'
import { resolveContext, getClient } from './resolve.js'

export async function handleShare(ctx: Context): Promise<void> {
  const resolved = await resolveContext(ctx)
  if (!resolved || !resolved.sessionId) {
    await ctx.reply('No active session to share.')
    return
  }

  const client = await getClient(ctx, resolved.projectDirectory)
  if (!client) return

  const result = await client.session.share({
    sessionID: resolved.sessionId,
  })

  if (result.data?.share?.url) {
    await ctx.reply(`Session shared: ${result.data.share.url}`)
  } else {
    await ctx.reply('Failed to create share link.')
  }
}
