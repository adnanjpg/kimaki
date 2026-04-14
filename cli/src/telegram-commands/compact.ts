import type { Context } from 'grammy'
import { resolveContext, getClient } from './resolve.js'

export async function handleCompact(ctx: Context): Promise<void> {
  const resolved = await resolveContext(ctx)
  if (!resolved || !resolved.sessionId) {
    await ctx.reply('No active session to compact.')
    return
  }

  const client = await getClient(ctx, resolved.projectDirectory)
  if (!client) return

  // Get model from last message for summarization
  const messages = await client.session.messages({
    sessionID: resolved.sessionId,
    directory: resolved.projectDirectory,
  })
  const lastAssistant = [...(messages.data || [])].reverse().find(
    (m) => m.role === 'assistant' && m.info?.model,
  )
  const provider = lastAssistant?.info?.model?.providerID
  const model = lastAssistant?.info?.model?.modelID

  if (!provider || !model) {
    await ctx.reply('Cannot determine model for compaction. Send a message first.')
    return
  }

  const result = await client.session.summarize({
    sessionID: resolved.sessionId,
    directory: resolved.projectDirectory,
    providerID: provider,
    modelID: model,
    auto: false,
  })

  if (result.error) {
    await ctx.reply(`Failed to compact: ${result.error}`)
    return
  }

  await ctx.reply('Session compacted successfully.')
}
