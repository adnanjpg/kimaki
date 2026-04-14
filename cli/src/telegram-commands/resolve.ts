// Shared resolution helpers for Telegram command handlers.
// Resolves project directory and session from Telegram chat context.

import {
  getChannelDirectory,
  getThreadSession,
  getPrisma,
} from '../database.js'
import {
  composeTelegramThreadId,
  composeTelegramChannelId,
} from '../telegram-utils.js'
import {
  getOpencodeClient,
  initializeOpencodeForDirectory,
} from '../opencode.js'
import type { Context } from 'grammy'

export type ResolvedContext = {
  chatId: number
  threadId: string
  channelId: string
  projectDirectory: string
  sessionId: string | null
}

/**
 * Resolve project directory and session from a Telegram message context.
 * Returns null with an error reply if resolution fails.
 */
export async function resolveContext(ctx: Context): Promise<ResolvedContext | null> {
  const chatId = ctx.chat?.id
  if (!chatId) {
    await ctx.reply('Cannot determine chat ID.')
    return null
  }

  const topicId = ctx.message?.message_thread_id || 0
  const threadId = composeTelegramThreadId(chatId, topicId)
  const channelId = composeTelegramChannelId(chatId)

  // Try to get project directory from this specific chat
  let channelConfig = await getChannelDirectory(channelId)

  // Fall back to any configured directory
  if (!channelConfig) {
    const prisma = await getPrisma()
    const anyChannel = await prisma.channel_directories.findFirst()
    if (anyChannel) {
      channelConfig = { directory: anyChannel.directory }
    }
  }

  if (!channelConfig) {
    await ctx.reply('No project directory configured. Use /addproject first.')
    return null
  }

  const sessionId = await getThreadSession(threadId) ?? null

  return {
    chatId,
    threadId,
    channelId,
    projectDirectory: channelConfig.directory,
    sessionId,
  }
}

/**
 * Get an OpenCode client for the resolved directory.
 * Returns null with an error reply if initialization fails.
 */
export async function getClient(ctx: Context, directory: string) {
  const existing = getOpencodeClient(directory)
  if (existing) {
    return existing
  }

  const result = await initializeOpencodeForDirectory(directory)
  if (result instanceof Error) {
    await ctx.reply(`Failed to connect to OpenCode: ${result.message}`)
    return null
  }
  return result()
}
