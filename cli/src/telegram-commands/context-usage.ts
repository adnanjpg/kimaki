import type { Context } from 'grammy'
import { resolveContext, getClient } from './resolve.js'

export async function handleContextUsage(ctx: Context): Promise<void> {
  const resolved = await resolveContext(ctx)
  if (!resolved || !resolved.sessionId) {
    await ctx.reply('No active session.')
    return
  }

  const client = await getClient(ctx, resolved.projectDirectory)
  if (!client) return

  const messages = await client.session.messages({
    sessionID: resolved.sessionId,
    directory: resolved.projectDirectory,
  })

  let totalInput = 0
  let totalOutput = 0
  let totalReasoning = 0
  let totalCacheRead = 0
  let totalCacheWrite = 0
  let totalCost = 0
  let modelId = ''

  for (const msg of messages.data || []) {
    if (msg.info?.tokens) {
      totalInput += msg.info.tokens.input || 0
      totalOutput += msg.info.tokens.output || 0
      totalReasoning += msg.info.tokens.reasoning || 0
      totalCacheRead += msg.info.tokens.cache?.read || 0
      totalCacheWrite += msg.info.tokens.cache?.write || 0
    }
    if (msg.info?.cost) {
      totalCost += msg.info.cost
    }
    if (msg.info?.model?.modelID) {
      modelId = msg.info.model.modelID
    }
  }

  const totalTokens = totalInput + totalOutput + totalReasoning + totalCacheRead + totalCacheWrite

  // Try to get context limit
  let contextInfo = ''
  try {
    const providers = await client.provider.list({ directory: resolved.projectDirectory })
    for (const p of providers.data || []) {
      const model = p.models?.[modelId]
      if (model?.limit?.context) {
        const pct = ((totalTokens / model.limit.context) * 100).toFixed(1)
        contextInfo = ` (${pct}% of ${(model.limit.context / 1000).toFixed(0)}k limit)`
        break
      }
    }
  } catch { /* non-critical */ }

  const costStr = totalCost > 0 ? `\nSession cost: $${totalCost.toFixed(4)}` : ''

  await ctx.reply(
    `<b>Context usage:</b> ${totalTokens.toLocaleString()} tokens${contextInfo}\n` +
    `<b>Model:</b> <code>${modelId}</code>\n` +
    `Input: ${totalInput.toLocaleString()} | Output: ${totalOutput.toLocaleString()} | Reasoning: ${totalReasoning.toLocaleString()}\n` +
    `Cache read: ${totalCacheRead.toLocaleString()} | Cache write: ${totalCacheWrite.toLocaleString()}` +
    costStr,
    { parse_mode: 'HTML' },
  )
}
