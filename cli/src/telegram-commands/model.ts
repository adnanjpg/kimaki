import type { Context } from 'grammy'
import { resolveContext, getClient } from './resolve.js'
import {
  setSessionModel,
  setChannelModel,
  getThreadSession,
} from '../database.js'
import { getRuntime } from '../session-handler/thread-session-runtime.js'

export async function handleModel(ctx: Context): Promise<void> {
  const resolved = await resolveContext(ctx)
  if (!resolved) return

  const client = await getClient(ctx, resolved.projectDirectory)
  if (!client) return

  // Get available providers and models
  const providers = await client.provider.list({
    directory: resolved.projectDirectory,
  })

  const connected = providers.data?.filter((p) =>
    providers.connected?.includes(p.id),
  ) || []

  if (connected.length === 0) {
    await ctx.reply('No AI providers connected. Configure a provider in OpenCode first.')
    return
  }

  // Check if user provided a model name directly: /model provider/modelId
  const args = (ctx.message?.text || '').replace(/^\/model\s*/i, '').trim()

  if (args) {
    // Direct model selection: "anthropic/claude-sonnet-4-20250514"
    const [providerId, modelId] = args.includes('/')
      ? [args.split('/')[0], args.split('/').slice(1).join('/')]
      : [undefined, args]

    // Find matching model
    let found = false
    for (const provider of connected) {
      for (const [mId, model] of Object.entries(provider.models || {})) {
        const matchesModel = mId === modelId || mId.includes(modelId || '')
        const matchesProvider = !providerId || provider.id === providerId
        if (matchesModel && matchesProvider) {
          // Set the model
          if (resolved.sessionId) {
            await setSessionModel({
              sessionId: resolved.sessionId,
              modelId: `${provider.id}/${mId}`,
            })
            // Try to retry with new model
            const runtime = getRuntime(resolved.threadId)
            if (runtime) {
              const retried = await runtime.retryLastUserPrompt()
              const retryNote = retried
                ? '\n_Restarting current request with new model..._'
                : ''
              await ctx.reply(
                `Model set for this session: **${provider.name || provider.id}** / **${model.name || mId}**${retryNote}`,
                { parse_mode: 'Markdown' },
              )
            } else {
              await ctx.reply(
                `Model set for this session: **${provider.name || provider.id}** / **${model.name || mId}**`,
                { parse_mode: 'Markdown' },
              )
            }
          } else {
            await setChannelModel({
              channelId: resolved.channelId,
              modelId: `${provider.id}/${mId}`,
            })
            await ctx.reply(
              `Model set for this channel: **${provider.name || provider.id}** / **${model.name || mId}**`,
              { parse_mode: 'Markdown' },
            )
          }
          found = true
          break
        }
      }
      if (found) break
    }

    if (!found) {
      await ctx.reply(`Model "${args}" not found. Use /model to see available models.`)
    }
    return
  }

  // No args — show available models as inline keyboard
  const buttons: Array<{ text: string; callback_data: string }[]> = []

  for (const provider of connected) {
    const models = Object.entries(provider.models || {})
    for (const [mId, model] of models.slice(0, 20)) {
      const label = `${provider.id}/${model.name || mId}`
      const data = `model:${provider.id}/${mId}`.slice(0, 64)
      buttons.push([{ text: label, callback_data: data }])
    }
  }

  if (buttons.length === 0) {
    await ctx.reply('No models available from connected providers.')
    return
  }

  await ctx.reply('Select a model:', {
    reply_markup: { inline_keyboard: buttons.slice(0, 30) },
  })
}

/**
 * Handle model selection callback from inline keyboard.
 * Called from telegram-bot.ts callback query router.
 */
export async function handleModelCallback(ctx: Context, data: string): Promise<void> {
  // data format: "model:provider/modelId"
  const modelPath = data.replace('model:', '')

  const chatId = ctx.callbackQuery?.message?.chat.id
  if (!chatId) {
    await ctx.answerCallbackQuery({ text: 'Error' })
    return
  }

  const topicId = ctx.callbackQuery?.message?.message_thread_id || 0
  const { composeTelegramThreadId, composeTelegramChannelId } = await import('../telegram-utils.js')
  const threadId = composeTelegramThreadId(chatId, topicId)
  const channelId = composeTelegramChannelId(chatId)

  const sessionId = await getThreadSession(threadId)
  if (sessionId) {
    await setSessionModel({ sessionId, modelId: modelPath })
    const runtime = getRuntime(threadId)
    if (runtime) {
      const retried = await runtime.retryLastUserPrompt()
      const retryNote = retried ? '\nRestarting with new model...' : ''
      await ctx.answerCallbackQuery({ text: `Model set: ${modelPath}${retryNote}` })
    } else {
      await ctx.answerCallbackQuery({ text: `Model set: ${modelPath}` })
    }
  } else {
    await setChannelModel({ channelId, modelId: modelPath })
    await ctx.answerCallbackQuery({ text: `Model set for channel: ${modelPath}` })
  }

  // Update the message to show selection
  await ctx.editMessageText(`Model set to: \`${modelPath}\``, {
    parse_mode: 'Markdown',
  }).catch(() => {})
}
