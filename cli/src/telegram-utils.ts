// Telegram-specific utility functions.
// Permission checks, ID composition, and message helpers for the Telegram bot.

import type { Api, RawApi } from 'grammy'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.TELEGRAM)

// ── Telegram ID composition ──────────────────────────────────────
// Thread IDs use the format "tg:{chatId}:{topicId}" to avoid collisions
// with Discord snowflakes in shared database tables.

export function composeTelegramThreadId(chatId: number | string, topicId: number): string {
  return `tg:${chatId}:${topicId}`
}

export function composeTelegramChannelId(chatId: number | string): string {
  return `tg:${chatId}`
}

export function parseTelegramThreadId(threadId: string): { chatId: string; topicId: number } | null {
  if (!threadId.startsWith('tg:')) {
    return null
  }
  const parts = threadId.split(':')
  if (parts.length !== 3) {
    return null
  }
  const topicId = parseInt(parts[2]!, 10)
  if (!Number.isFinite(topicId)) {
    return null
  }
  return { chatId: parts[1]!, topicId }
}

export function isTelegramThreadId(threadId: string): boolean {
  return threadId.startsWith('tg:')
}

// ── Permission checks ────────────────────────────────────────────
// Telegram uses chat member status for permissions. Admins and creators
// can use the bot; regular members need explicit allowlisting.

export type TelegramMemberStatus =
  | 'creator'
  | 'administrator'
  | 'member'
  | 'restricted'
  | 'left'
  | 'kicked'

export async function hasTelegramBotPermission(
  api: Api<RawApi>,
  chatId: number | string,
  userId: number,
): Promise<boolean> {
  try {
    const member = await api.getChatMember(chatId, userId)
    // Creators and administrators always have access
    if (member.status === 'creator' || member.status === 'administrator') {
      return true
    }
    // Regular members have access by default (no role system like Discord).
    // This can be restricted later with a custom allowlist if needed.
    if (member.status === 'member') {
      return true
    }
    return false
  } catch (error) {
    logger.error(`Failed to check permissions for user ${userId}:`, error)
    return false
  }
}

// ── Message helpers ──────────────────────────────────────────────

/**
 * Extract text content from a Telegram message, including captions
 * from photos/documents.
 */
export function extractMessageText(message: {
  text?: string
  caption?: string
}): string {
  return message.text || message.caption || ''
}

/**
 * Get a display name for a Telegram user.
 */
export function getTelegramDisplayName(from: {
  first_name: string
  last_name?: string
  username?: string
}): string {
  if (from.last_name) {
    return `${from.first_name} ${from.last_name}`
  }
  return from.first_name
}

/**
 * Truncate text for use as a forum topic name (max 128 chars).
 */
export function truncateTopicName(text: string, maxLength = 128): string {
  const cleaned = text.replace(/\n/g, ' ').trim()
  if (cleaned.length <= maxLength) {
    return cleaned
  }
  return cleaned.slice(0, maxLength - 1) + '\u2026'
}
