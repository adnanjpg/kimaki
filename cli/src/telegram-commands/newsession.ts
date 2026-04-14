import type { Context } from 'grammy'
import { resolveContext, getClient } from './resolve.js'
import { getRuntime, disposeRuntime, getOrCreateRuntime } from '../session-handler/thread-session-runtime.js'
import { setThreadSession } from '../database.js'
import { TelegramThread } from '../platform/telegram-thread.js'

export async function handleNewSession(ctx: Context): Promise<void> {
  const resolved = await resolveContext(ctx)
  if (!resolved) return

  const prompt = ctx.match?.toString().trim() || ''

  // Abort any active run on the old session
  const oldRuntime = getRuntime(resolved.threadId)
  if (oldRuntime) {
    oldRuntime.abortActiveRun('user /newsession command')
  }

  // Abort the old session in OpenCode
  if (resolved.sessionId) {
    const client = await getClient(ctx, resolved.projectDirectory)
    if (client) {
      await client.session.abort({
        sessionID: resolved.sessionId,
        directory: resolved.projectDirectory,
      }).catch(() => {})
    }
  }

  // Dispose old runtime
  disposeRuntime(resolved.threadId)

  // Create a fresh session in OpenCode
  const client = await getClient(ctx, resolved.projectDirectory)
  if (!client) return

  const newSession = await client.session.create({
    directory: resolved.projectDirectory,
  })

  if (!newSession.data) {
    await ctx.reply('Failed to create new session.')
    return
  }

  // Persist the new session mapping
  await setThreadSession(resolved.threadId, newSession.data.id)

  await ctx.reply(
    `New session started: \`${newSession.data.id}\`${prompt ? `\nSending: ${prompt}` : ''}`,
    { parse_mode: 'Markdown' },
  )

  // If a prompt was provided, enqueue it in the new session
  if (prompt) {
    const chatId = ctx.chat!.id
    const topicId = ctx.message?.message_thread_id || 0
    const userId = ctx.from?.id || 0
    const username = ctx.from?.username || ctx.from?.first_name || 'user'

    const thread = new TelegramThread({
      api: ctx.api,
      chatId,
      topicId,
      topicName: 'session',
      serverId: String(chatId),
    })

    const runtime = getOrCreateRuntime({
      threadId: resolved.threadId,
      thread,
      projectDirectory: resolved.projectDirectory,
      sdkDirectory: resolved.projectDirectory,
      channelId: resolved.channelId,
    })

    await runtime.enqueueIncoming({
      prompt,
      userId: String(userId),
      username,
    })
  }
}
