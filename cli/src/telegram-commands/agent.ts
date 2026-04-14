import type { Context } from 'grammy'
import { resolveContext, getClient } from './resolve.js'
import { setSessionAgent, setChannelAgent } from '../database.js'

export async function handleAgent(ctx: Context): Promise<void> {
  const resolved = await resolveContext(ctx)
  if (!resolved) return

  const client = await getClient(ctx, resolved.projectDirectory)
  if (!client) return

  const args = (ctx.message?.text || '').replace(/^\/agent\s*/i, '').trim()

  // Get available agents
  const agentsResult = await client.app.agents({ directory: resolved.projectDirectory })
  const agents = (agentsResult.data || []).filter((a) => a.mode === 'primary' || a.mode === 'all')

  if (agents.length === 0) {
    await ctx.reply('No agents available.')
    return
  }

  if (args) {
    const match = agents.find((a) => a.name === args || a.name.includes(args))
    if (!match) {
      await ctx.reply(`Agent "${args}" not found. Use /agent to see available agents.`)
      return
    }

    if (resolved.sessionId) {
      await setSessionAgent(resolved.sessionId, match.name)
      await ctx.reply(
        `Agent set for this session: **${match.name}**\nThe agent will change on the next message.`,
        { parse_mode: 'Markdown' },
      )
    } else {
      await setChannelAgent(resolved.channelId, match.name)
      await ctx.reply(
        `Agent set for this channel: **${match.name}**\nAll new sessions will use this agent.`,
        { parse_mode: 'Markdown' },
      )
    }
    return
  }

  // Show agents as inline keyboard
  const buttons = agents.slice(0, 20).map((a) => [{
    text: a.name,
    callback_data: `agent:${a.name}`.slice(0, 64),
  }])

  await ctx.reply('Select an agent:', {
    reply_markup: { inline_keyboard: buttons },
  })
}

export async function handleAgentCallback(ctx: Context, data: string): Promise<void> {
  const agentName = data.replace('agent:', '')
  const chatId = ctx.callbackQuery?.message?.chat.id
  if (!chatId) {
    await ctx.answerCallbackQuery({ text: 'Error' })
    return
  }

  const { composeTelegramThreadId, composeTelegramChannelId } = await import('../telegram-utils.js')
  const topicId = ctx.callbackQuery?.message?.message_thread_id || 0
  const threadId = composeTelegramThreadId(chatId, topicId)
  const channelId = composeTelegramChannelId(chatId)

  const { getThreadSession } = await import('../database.js')
  const sessionId = await getThreadSession(threadId)

  if (sessionId) {
    await setSessionAgent(sessionId, agentName)
    await ctx.answerCallbackQuery({ text: `Agent set: ${agentName}` })
  } else {
    await setChannelAgent(channelId, agentName)
    await ctx.answerCallbackQuery({ text: `Agent set for channel: ${agentName}` })
  }

  await ctx.editMessageText(`Agent set to: **${agentName}**`, {
    parse_mode: 'Markdown',
  }).catch(() => {})
}
