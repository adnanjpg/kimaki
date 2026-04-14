import type { Context } from 'grammy'
import { resolveContext, getClient } from './resolve.js'

export async function handleUndo(ctx: Context): Promise<void> {
  const resolved = await resolveContext(ctx)
  if (!resolved || !resolved.sessionId) {
    await ctx.reply('No active session.')
    return
  }

  const client = await getClient(ctx, resolved.projectDirectory)
  if (!client) return

  // Check if session is busy and abort first
  const status = await client.session.status({ directory: resolved.projectDirectory })
  const sessionStatus = status.data?.[resolved.sessionId]
  if (sessionStatus?.type === 'busy') {
    await client.session.abort({
      sessionID: resolved.sessionId,
      directory: resolved.projectDirectory,
    }).catch(() => {})
  }

  const session = await client.session.get({
    sessionID: resolved.sessionId,
    directory: resolved.projectDirectory,
  })

  const messages = await client.session.messages({
    sessionID: resolved.sessionId,
    directory: resolved.projectDirectory,
  })
  const msgList = messages.data || []

  // Find the last assistant message to revert to
  const lastAssistant = [...msgList].reverse().find((m) => m.info.role === 'assistant')
  if (!lastAssistant) {
    await ctx.reply('Nothing to undo — no assistant messages found.')
    return
  }

  const result = await client.session.revert({
    sessionID: resolved.sessionId,
    directory: resolved.projectDirectory,
    messageID: lastAssistant.info.id,
  })

  const diffSnippet = result.data?.revert?.diff
    ? `\n<pre>${result.data.revert.diff.slice(0, 500)}</pre>`
    : ''
  await ctx.reply(`Undone — reverted last assistant message.${diffSnippet}`, {
    parse_mode: 'HTML',
  })
}

export async function handleRedo(ctx: Context): Promise<void> {
  const resolved = await resolveContext(ctx)
  if (!resolved || !resolved.sessionId) {
    await ctx.reply('No active session.')
    return
  }

  const client = await getClient(ctx, resolved.projectDirectory)
  if (!client) return

  const session = await client.session.get({
    sessionID: resolved.sessionId,
    directory: resolved.projectDirectory,
  })

  if (!session.data?.revert?.messageID) {
    await ctx.reply('Nothing to redo — no previous undo found.')
    return
  }

  // Try unrevert (restore fully)
  const result = await client.session.unrevert({
    sessionID: resolved.sessionId,
    directory: resolved.projectDirectory,
  })

  await ctx.reply('Restored — session back to previous state.')
}
