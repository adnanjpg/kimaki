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
    (m) => m.info.role === 'assistant',
  )
  const provider = lastAssistant?.info.role === 'assistant' ? lastAssistant.info.providerID : undefined
  const model = lastAssistant?.info.role === 'assistant' ? lastAssistant.info.modelID : undefined

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
