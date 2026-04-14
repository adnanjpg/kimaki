// Core Telegram bot module — parallel to discord-bot.ts.
// Bridges Telegram messages to OpenCode sessions via forum topics.
// Uses grammy for the Bot API, PlatformThread for runtime abstraction.

import { Bot, type Context } from 'grammy'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import * as errore from 'errore'
import { createLogger, LogPrefix } from './logger.js'
import { transcribeAudio } from './voice.js'
import { execAsync } from './worktrees.js'
import { TelegramThread } from './platform/telegram-thread.js'
import {
  composeTelegramThreadId,
  composeTelegramChannelId,
  extractMessageText,
  getTelegramDisplayName,
  truncateTopicName,
  hasTelegramBotPermission,
} from './telegram-utils.js'
import {
  getChannelDirectory,
  getThreadSession,
  setChannelDirectory,
  getPrisma,
  getTranscriptionApiKey,
} from './database.js'
import { initializeOpencodeForDirectory } from './opencode.js'
import {
  getRuntime,
  getOrCreateRuntime,
  disposeRuntime,
} from './session-handler/thread-session-runtime.js'
import {
  cancelPendingActionButtons,
} from './commands/action-buttons.js'
import {
  cancelPendingPermission,
  pendingPermissionContexts,
} from './commands/permissions.js'
import {
  hasPendingQuestionForThread,
  cancelPendingQuestion,
  pendingQuestionContexts,
} from './commands/ask-question.js'
import {
  cancelPendingFileUpload,
} from './commands/file-upload.js'
import { cancelHtmlActionsForThread } from './html-actions.js'
import { getOpencodeClient } from './opencode.js'

const logger = createLogger(LogPrefix.TELEGRAM)

export type TelegramBotOptions = {
  token: string
  appId: string
}

/**
 * Start the Telegram bot. Connects via long polling, handles messages
 * in forum topics, and routes callback queries for interactive UI.
 */
export async function startTelegramBot(opts: TelegramBotOptions): Promise<Bot> {
  const bot = new Bot(opts.token)
  const appId = opts.appId
  let botUsername = ''

  // ── Bot identity ─────────────────────────────────────────────
  const me = await bot.api.getMe()
  botUsername = me.username || ''
  logger.log(`Telegram bot logged in as @${botUsername} (${me.id})`)

  // ── Commands ────────────────────────────────────────────────
  const { registerTelegramCommands } = await import('./telegram-commands/index.js')
  registerTelegramCommands(bot)

  // ── Message handler ──────────────────────────────────────────
  // Routes messages from DMs, groups, and supergroup forum topics
  bot.on('message', async (ctx) => {
    try {
      await handleTelegramMessage(ctx, appId, botUsername)
    } catch (error) {
      logger.error(
        `Error handling message: ${error instanceof Error ? error.stack : String(error)}`,
      )
    }
  })

  // ── Callback query handler: button clicks ────────────────────
  // Inline keyboard button presses for permissions, actions, questions
  bot.on('callback_query:data', async (ctx) => {
    try {
      await handleCallbackQuery(ctx)
    } catch (error) {
      logger.error(
        `Error handling callback query: ${error instanceof Error ? error.stack : String(error)}`,
      )
    }
  })

  // ── Error handler ────────────────────────────────────────────
  bot.catch((err) => {
    logger.error(`Bot error: ${err.error instanceof Error ? err.error.stack : String(err.error)}`)
  })

  // Start long polling (non-blocking)
  bot.start({
    onStart: () => {
      logger.log('Telegram bot started (long polling)')
    },
  })

  return bot
}

// ── Message routing ──────────────────────────────────────────────

async function handleTelegramMessage(ctx: Context, appId: string, botUsername: string): Promise<void> {
  const message = ctx.message
  if (!message || !message.from) {
    return
  }

  // Ignore bot's own messages
  if (message.from.is_bot) {
    return
  }

  const chatId = message.chat.id
  const chatType = message.chat.type

  const userId = message.from.id
  const username = getTelegramDisplayName(message.from)

  // ── Voice message handling ────────────────────────────────────
  // Telegram voice messages (.ogg opus) are transcribed to text before processing.
  if (message.voice || message.audio) {
    await handleVoiceMessage({ ctx, chatId, userId, username, appId, botUsername })
    return
  }

  // Strip @botname mention from the text so the prompt is clean
  let text = extractMessageText(message)
  if (botUsername) {
    text = text.replace(new RegExp(`@${botUsername}\\b`, 'gi'), '').trim()
  }

  // DMs and regular groups: one session per chat (no forum topics)
  if (chatType === 'private' || chatType === 'group') {
    await handleDirectMessage({
      ctx,
      chatId,
      userId,
      username,
      text,
      appId,
    })
    return
  }

  // Supergroups: support forum topics if available
  if (chatType !== 'supergroup') {
    return
  }

  // Check permission in groups
  if (!ctx.api) {
    return
  }
  const hasPermission = await hasTelegramBotPermission(ctx.api, chatId, userId)
  if (!hasPermission) {
    return
  }

  const topicId = message.message_thread_id

  if (topicId) {
    // Message is in an existing forum topic → route to runtime
    await handleTopicMessage({
      ctx,
      chatId,
      topicId,
      userId,
      username,
      text,
      appId,
    })
  } else {
    // Supergroup without topics, or message in general chat → one session per chat
    await handleDirectMessage({
      ctx,
      chatId,
      userId,
      username,
      text,
      appId,
    })
  }
}

// ── Auto-detect project directory from message ─────────────────
// When the user mentions a directory path in their message, check if it's
// a project root (has .git) and auto-bind the channel to it. This saves
// the user from having to manually /addproject when they say "cd ~/MyProject".

async function autoDetectProject({
  text,
  channelId,
  currentDirectory,
}: {
  text: string
  channelId: string
  currentDirectory: string
}): Promise<string | null> {
  // Extract paths: absolute (/home/...) or home-relative (~/...)
  const pathRegex = /(?:~\/[\w./-]+|\/(?:home|Users)\/[\w./-]+)/g
  const matches = text.match(pathRegex)
  if (!matches) return null

  for (const raw of matches) {
    const resolved = raw.startsWith('~/')
      ? path.join(os.homedir(), raw.slice(2))
      : raw

    // Walk up to find the closest directory that's a git repo
    let dir = resolved
    for (let i = 0; i < 5; i++) {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        dir = path.dirname(dir)
        continue
      }
      if (fs.existsSync(path.join(dir, '.git'))) {
        if (dir === currentDirectory) return null // already bound
        await setChannelDirectory({ channelId, directory: dir, channelType: 'text' })
        const result = await initializeOpencodeForDirectory(dir)
        if (result instanceof Error) {
          logger.error(`Auto-detect: failed to init OpenCode for ${dir}: ${result.message}`)
          return null
        }
        logger.log(`Auto-detect: bound channel ${channelId} to project ${dir}`)
        return dir
      }
      break
    }
  }

  return null
}

// ── Direct message handler ───────────────────────────────────────
// DMs to the bot — simplest flow, no group/topic needed.
// Each DM chat is one continuous session. The "topic ID" is 0
// (no forum topic), so the thread ID is "tg:{chatId}:0".

async function handleDirectMessage({
  ctx,
  chatId,
  userId,
  username,
  text,
  appId,
}: {
  ctx: Context
  chatId: number
  userId: number
  username: string
  text: string
  appId: string
}): Promise<void> {
  if (!text.trim()) {
    return
  }

  // In DM mode, use topicId=0 (no forum topic)
  const topicId = 0
  const threadId = composeTelegramThreadId(chatId, topicId)
  const channelId = composeTelegramChannelId(chatId)

  // Check if this DM chat has a project directory configured.
  // If not, check if ANY channel is configured (use first found as default).
  let channelConfig = await getChannelDirectory(channelId)

  if (!channelConfig) {
    // For DMs, try to use the first configured project directory as a fallback.
    // This makes testing easy — just bind a directory to the --chat flag
    // and DMs will automatically use it.
    const prisma = await getPrisma()
    const anyChannel = await prisma.channel_directories.findFirst()
    if (anyChannel) {
      channelConfig = { directory: anyChannel.directory }
    }
  }

  if (!channelConfig) {
    await ctx.reply(
      'No project directory configured yet.\n' +
      'Start the bot with --directory to set one, or use /addproject.',
    )
    return
  }

  // Auto-detect project directory from message text (e.g. "cd ~/UniRefund")
  const detectedDir = await autoDetectProject({
    text,
    channelId,
    currentDirectory: channelConfig.directory,
  })
  const projectDirectory = detectedDir || channelConfig.directory

  if (!fs.existsSync(projectDirectory)) {
    await ctx.reply(`Project directory does not exist: ${projectDirectory}`)
    return
  }

  // Ensure OpenCode is initialized for this directory
  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    await ctx.reply(`Failed to start OpenCode: ${getClient.message}`)
    return
  }

  const thread = new TelegramThread({
    api: ctx.api,
    chatId,
    topicId,
    topicName: 'DM session',
    serverId: String(chatId),
  })

  const runtime = getOrCreateRuntime({
    threadId,
    thread,
    projectDirectory,
    sdkDirectory: projectDirectory,
    channelId,
    appId,
  })

  // Cancel interactive UI when user sends a new message
  cancelPendingActionButtons(threadId)
  cancelHtmlActionsForThread(threadId)
  const dismissedPermission = await cancelPendingPermission(threadId)
  if (dismissedPermission) {
    await runtime.abortActiveRunAndWait({
      reason: 'user sent a new message while permission was pending',
    })
  }
  const dismissedQuestion = hasPendingQuestionForThread(threadId)
  if (dismissedQuestion) {
    await cancelPendingQuestion(threadId)
    await runtime.abortActiveRunAndWait({
      reason: 'user sent a new message while question was pending',
    })
  }

  await runtime.enqueueIncoming({
    prompt: text,
    userId: String(userId),
    username,
    appId,
  })

  logger.log(
    `DM session for ${username}: "${text.slice(0, 50)}..."`,
  )
}

// ── Voice message handler ────────────────────────────────────────
// Telegram voice messages (.ogg opus) and audio files are transcribed
// via the transcribeAudio() pipeline (Gemini / OpenAI) and then
// routed as a normal text prompt. API keys are read from env vars
// (loaded from ~/.kimaki/.env) or the database.

async function handleVoiceMessage({
  ctx,
  chatId,
  userId,
  username,
  appId,
  botUsername,
}: {
  ctx: Context
  chatId: number
  userId: number
  username: string
  appId: string
  botUsername: string
}): Promise<void> {
  const message = ctx.message!
  const voice = message.voice || message.audio
  if (!voice) return

  const chatType = message.chat.type
  const topicId = ('message_thread_id' in message && message.message_thread_id) || 0
  const threadId = composeTelegramThreadId(chatId, topicId)
  const channelId = composeTelegramChannelId(chatId)

  // Resolve project directory
  let channelConfig = await getChannelDirectory(channelId)
  if (!channelConfig) {
    const prisma = await getPrisma()
    const anyChannel = await prisma.channel_directories.findFirst()
    if (anyChannel) {
      channelConfig = { directory: anyChannel.directory }
    }
  }
  if (!channelConfig) {
    await ctx.reply('No project directory configured. Use /addproject first.')
    return
  }
  const projectDirectory = channelConfig.directory

  // Tell user we're transcribing
  const threadParam = topicId > 0 ? { message_thread_id: topicId } : {}
  await ctx.reply('Transcribing voice message...', threadParam)

  // Download voice file from Telegram
  const file = await ctx.api.getFile(voice.file_id)
  if (!file.file_path) {
    await ctx.reply('Failed to download voice message.', threadParam)
    return
  }

  const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
  const response = await fetch(fileUrl)
  if (!response.ok) {
    await ctx.reply('Failed to download voice message.', threadParam)
    return
  }
  const audioBuffer = Buffer.from(await response.arrayBuffer())

  logger.log(`Downloaded voice message: ${audioBuffer.length} bytes, mime: ${voice.mime_type || 'audio/ogg'}`)

  // Build file tree for transcription context
  let transcriptionPrompt = 'Telegram voice message transcription'
  try {
    const { stdout } = await execAsync('git ls-files | tree --fromfile -a', {
      cwd: projectDirectory,
    })
    if (stdout) {
      transcriptionPrompt = stdout
    }
  } catch { /* non-critical */ }

  // Resolve transcription API key: DB → env vars
  let transcriptionApiKey: string | undefined
  let transcriptionProvider: 'openai' | 'gemini' | undefined
  const stored = await getTranscriptionApiKey(appId)
  if (stored) {
    transcriptionApiKey = stored.apiKey
    transcriptionProvider = stored.provider
  }
  if (!transcriptionApiKey) {
    if (process.env.GEMINI_API_KEY) {
      transcriptionApiKey = process.env.GEMINI_API_KEY
      transcriptionProvider = 'gemini'
    } else if (process.env.OPENAI_API_KEY) {
      transcriptionApiKey = process.env.OPENAI_API_KEY
      transcriptionProvider = 'openai'
    }
  }

  if (!transcriptionApiKey) {
    await ctx.reply(
      'Voice transcription requires a GEMINI_API_KEY or OPENAI_API_KEY.\n' +
      'Add it to ~/.kimaki/.env:\n\n' +
      '`GEMINI_API_KEY=your-key-here`',
      { ...threadParam, parse_mode: 'Markdown' },
    )
    return
  }

  // Transcribe
  const result = await transcribeAudio({
    audio: audioBuffer,
    prompt: transcriptionPrompt,
    apiKey: transcriptionApiKey,
    provider: transcriptionProvider,
    mediaType: voice.mime_type || 'audio/ogg',
  })

  if (result instanceof Error) {
    logger.error(`Voice transcription failed:`, result)
    await ctx.reply(`Transcription failed: ${result.message}`, threadParam)
    return
  }

  const { transcription: text, queueMessage, agent } = result
  logger.log(
    `Voice transcribed: "${text.slice(0, 80)}"${queueMessage ? ' [QUEUE]' : ''}${agent ? ` [AGENT:${agent}]` : ''}`,
  )

  // Show transcription to user
  await ctx.reply(`Transcribed: ${text}`, threadParam)

  // Route transcribed text through the normal handler
  if (chatType === 'private' || chatType === 'group' || topicId === 0) {
    await handleDirectMessage({ ctx, chatId, userId, username, text, appId })
  } else {
    await handleTopicMessage({ ctx, chatId, topicId, userId, username, text, appId })
  }
}

// ── Topic message handler ────────────────────────────────────────

async function handleTopicMessage({
  ctx,
  chatId,
  topicId,
  userId,
  username,
  text,
  appId,
}: {
  ctx: Context
  chatId: number
  topicId: number
  userId: number
  username: string
  text: string
  appId: string
}): Promise<void> {
  const threadId = composeTelegramThreadId(chatId, topicId)

  // Check if we have a runtime or DB session for this topic
  const existingRuntime = getRuntime(threadId)
  const hasExistingSession = await getThreadSession(threadId)

  if (!existingRuntime && !hasExistingSession) {
    // Unknown topic — try to see if the parent chat has a project directory
    const channelId = composeTelegramChannelId(chatId)
    let channelConfig = await getChannelDirectory(channelId)

    if (!channelConfig) {
      // Fallback: use any configured project directory (same as DM handler)
      const prisma = await getPrisma()
      const anyChannel = await prisma.channel_directories.findFirst()
      if (anyChannel) {
        channelConfig = { directory: anyChannel.directory }
      }
    }

    if (!channelConfig) {
      logger.log(`Ignoring message in topic ${topicId}: no project directory configured for chat ${chatId}`)
      return
    }

    // Auto-detect project directory from message text
    const detectedDir = await autoDetectProject({
      text,
      channelId,
      currentDirectory: channelConfig.directory,
    })

    // Start a new session in this existing topic
    await startSessionInTopic({
      ctx,
      chatId,
      topicId,
      projectDirectory: detectedDir || channelConfig.directory,
      userId,
      username,
      text,
      appId,
    })
    return
  }

  // Route to existing runtime
  const channelId = composeTelegramChannelId(chatId)
  let channelConfig = await getChannelDirectory(channelId)
  if (!channelConfig) {
    const prisma = await getPrisma()
    const anyChannel = await prisma.channel_directories.findFirst()
    if (anyChannel) {
      channelConfig = { directory: anyChannel.directory }
    }
  }
  if (!channelConfig) {
    return
  }

  // Auto-detect project directory from message text
  const detectedDir2 = await autoDetectProject({
    text,
    channelId,
    currentDirectory: channelConfig.directory,
  })
  const projectDirectory = detectedDir2 || channelConfig.directory

  if (!fs.existsSync(projectDirectory)) {
    logger.error(`Directory does not exist: ${projectDirectory}`)
    await ctx.reply(`Directory does not exist: ${projectDirectory}`)
    return
  }

  // Get or create chat description for context
  const chatDescription = await getChatDescription(ctx, chatId)

  const thread = new TelegramThread({
    api: ctx.api,
    chatId,
    topicId,
    topicName: text.slice(0, 30) || 'session',
    serverId: String(chatId),
    chatDescription,
  })

  const runtime = getOrCreateRuntime({
    threadId,
    thread,
    projectDirectory,
    sdkDirectory: projectDirectory,
    channelId,
    appId,
  })

  // Cancel interactive UI when user sends a new message
  cancelPendingActionButtons(threadId)
  cancelHtmlActionsForThread(threadId)
  const dismissedPermission = await cancelPendingPermission(threadId)
  if (dismissedPermission) {
    await runtime.abortActiveRunAndWait({
      reason: 'user sent a new message while permission was pending',
    })
  }
  const dismissedQuestion = hasPendingQuestionForThread(threadId)
  if (dismissedQuestion) {
    await cancelPendingQuestion(threadId)
    await runtime.abortActiveRunAndWait({
      reason: 'user sent a new message while question was pending',
    })
  }

  if (!text.trim()) {
    return
  }

  await runtime.enqueueIncoming({
    prompt: text,
    userId: String(userId),
    username,
    appId,
  })
}

// ── New session handler ──────────────────────────────────────────

async function handleNewSessionMessage({
  ctx,
  chatId,
  userId,
  username,
  text,
  appId,
}: {
  ctx: Context
  chatId: number
  userId: number
  username: string
  text: string
  appId: string
}): Promise<void> {
  if (!text.trim()) {
    return
  }

  const channelId = composeTelegramChannelId(chatId)
  const channelConfig = await getChannelDirectory(channelId)

  if (!channelConfig) {
    await ctx.reply(
      'This chat is not connected to a project directory.\n' +
      'Use /addproject <path> to connect a directory.',
    )
    return
  }

  const projectDirectory = channelConfig.directory

  if (!fs.existsSync(projectDirectory)) {
    await ctx.reply(`Directory does not exist: ${projectDirectory}`)
    return
  }

  // Create a new forum topic for this session
  const topicName = truncateTopicName(text)
  const topicResult = await errore.tryAsync(() => {
    return ctx.api.createForumTopic(chatId, topicName)
  })

  if (topicResult instanceof Error) {
    logger.error('Failed to create forum topic:', topicResult)
    await ctx.reply(
      'Failed to create a forum topic for this session. ' +
      'Make sure the group has Topics enabled.',
    )
    return
  }

  const topicId = topicResult.message_thread_id
  logger.log(`Created forum topic "${topicName}" (${topicId}) in chat ${chatId}`)

  await startSessionInTopic({
    ctx,
    chatId,
    topicId,
    projectDirectory,
    userId,
    username,
    text,
    appId,
  })
}

// ── Start session in topic ───────────────────────────────────────

async function startSessionInTopic({
  ctx,
  chatId,
  topicId,
  projectDirectory,
  userId,
  username,
  text,
  appId,
}: {
  ctx: Context
  chatId: number
  topicId: number
  projectDirectory: string
  userId: number
  username: string
  text: string
  appId: string
}): Promise<void> {
  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    await ctx.api.sendMessage(chatId, `Failed to start OpenCode: ${getClient.message}`, {
      message_thread_id: topicId,
    })
    return
  }

  const threadId = composeTelegramThreadId(chatId, topicId)
  const channelId = composeTelegramChannelId(chatId)
  const chatDescription = await getChatDescription(ctx, chatId)

  const thread = new TelegramThread({
    api: ctx.api,
    chatId,
    topicId,
    topicName: text.slice(0, 30) || 'session',
    serverId: String(chatId),
    chatDescription,
  })

  const runtime = getOrCreateRuntime({
    threadId,
    thread,
    projectDirectory,
    sdkDirectory: projectDirectory,
    channelId,
    appId,
  })

  await runtime.enqueueIncoming({
    prompt: text,
    userId: String(userId),
    username,
    appId,
  })

  logger.log(
    `Started session in topic ${topicId} for user ${username} with prompt: "${text.slice(0, 50)}..."`,
  )
}

// ── Callback query handler ───────────────────────────────────────
// Routes inline keyboard button presses to the appropriate handler
// based on the callback_data prefix.

async function handleCallbackQuery(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data
  if (!data) {
    await ctx.answerCallbackQuery()
    return
  }

  // Permission buttons: "permission_once:{hash}", "permission_always:{hash}", "permission_reject:{hash}"
  if (data.startsWith('permission_')) {
    await handleTelegramPermissionCallback(ctx, data)
    return
  }

  // Action buttons: "action_button:{hash}:{index}"
  if (data.startsWith('action_button:')) {
    await handleTelegramActionCallback(ctx, data)
    return
  }

  // Question select: "ask_question:{hash}:{questionIdx}:{optionValue}"
  if (data.startsWith('ask_question:')) {
    await handleTelegramQuestionCallback(ctx, data)
    return
  }

  // Model selection: "model:provider/modelId"
  if (data.startsWith('model:')) {
    const { handleModelCallback } = await import('./telegram-commands/model.js')
    await handleModelCallback(ctx, data)
    return
  }

  // Agent selection: "agent:agentName"
  if (data.startsWith('agent:')) {
    const { handleAgentCallback } = await import('./telegram-commands/agent.js')
    await handleAgentCallback(ctx, data)
    return
  }

  // Verbosity selection: "verbosity:level"
  if (data.startsWith('verbosity:')) {
    const { handleVerbosityCallback } = await import('./telegram-commands/verbosity.js')
    await handleVerbosityCallback(ctx, data)
    return
  }

  await ctx.answerCallbackQuery({ text: 'Unknown action' })
}

// ── Permission callback ──────────────────────────────────────────

async function handleTelegramPermissionCallback(ctx: Context, data: string): Promise<void> {
  // Format: "permission_once:{contextHash}" or "permission_always:{contextHash}" or "permission_reject:{contextHash}"
  const [actionPart, contextHash] = data.split(':')
  if (!actionPart || !contextHash) {
    await ctx.answerCallbackQuery({ text: 'Invalid action' })
    return
  }

  const response = actionPart.replace('permission_', '') as 'once' | 'always' | 'reject'
  const context = pendingPermissionContexts.get(contextHash)

  if (!context) {
    await ctx.answerCallbackQuery({ text: 'This permission has expired.' })
    return
  }

  pendingPermissionContexts.delete(contextHash)

  try {
    const permClient = getOpencodeClient(context.directory)
    if (!permClient) {
      throw new Error('OpenCode server not found')
    }

    const requestIds = context.requestIds.length > 0
      ? context.requestIds
      : [context.permission.id]

    await Promise.all(
      requestIds.map((requestId) => {
        return permClient.permission.reply({
          requestID: requestId,
          directory: context.permissionDirectory,
          reply: response,
        })
      }),
    )

    const statusText = response === 'once' ? 'Accepted'
      : response === 'always' ? 'Accepted Always'
      : 'Denied'

    await ctx.answerCallbackQuery({ text: `Permission ${statusText}` })

    // Update the message to show the result
    if (context.messageId) {
      await context.thread.edit(context.messageId, {
        content: `Permission ${statusText}`,
      })
    }
  } catch (error) {
    logger.error('Failed to handle permission callback:', error)
    await ctx.answerCallbackQuery({ text: 'Failed to process permission' })
  }
}

// ── Action button callback ───────────────────────────────────────

async function handleTelegramActionCallback(ctx: Context, data: string): Promise<void> {
  // Format: "action_button:{contextHash}:{index}"
  const parts = data.split(':')
  const contextHash = parts[1]
  const indexPart = parts[2]

  if (!contextHash || !indexPart) {
    await ctx.answerCallbackQuery({ text: 'Invalid action' })
    return
  }

  const { pendingActionButtonContexts } = await import('./commands/action-buttons.js')
  const context = pendingActionButtonContexts.get(contextHash)

  if (!context || context.resolved) {
    await ctx.answerCallbackQuery({ text: 'This action is no longer available.' })
    return
  }

  const buttonIndex = parseInt(indexPart, 10)
  const button = context.buttons[buttonIndex]
  if (!button) {
    await ctx.answerCallbackQuery({ text: 'Invalid button' })
    return
  }

  await ctx.answerCallbackQuery({ text: `Selected: ${button.label}` })

  // Mark resolved
  context.resolved = true
  clearTimeout(context.timer)
  pendingActionButtonContexts.delete(contextHash)

  // Update message
  if (context.messageId) {
    await context.thread.edit(context.messageId, {
      content: `**Action Required**\n_Selected: ${button.label}_`,
    })
  }

  // Send the click as a new prompt to the model
  const runtime = getRuntime(context.thread.id)
  if (runtime) {
    const prompt = `User clicked: ${button.label}`
    await runtime.enqueueIncoming({
      prompt,
      userId: String(ctx.callbackQuery?.from?.id || 0),
      username: ctx.callbackQuery?.from ? getTelegramDisplayName(ctx.callbackQuery.from) : 'user',
      mode: 'opencode',
    })
  }
}

// ── Question callback ────────────────────────────────────────────

async function handleTelegramQuestionCallback(ctx: Context, data: string): Promise<void> {
  // Format: "ask_question:{contextHash}:{questionIdx}:{optionValue}"
  // But callback_data max is 64 bytes, so we encode compactly:
  // "ask_question:{contextHash}:{questionIdx}:{optionIdx}"
  const parts = data.split(':')
  const contextHash = parts[1]
  const questionIndexStr = parts[2]
  const optionValue = parts[3]

  if (!contextHash || !questionIndexStr || optionValue === undefined) {
    await ctx.answerCallbackQuery({ text: 'Invalid selection' })
    return
  }

  const context = pendingQuestionContexts.get(contextHash)
  if (!context) {
    await ctx.answerCallbackQuery({ text: 'This question has expired.' })
    return
  }

  const questionIndex = parseInt(questionIndexStr, 10)
  const question = context.questions[questionIndex]
  if (!question) {
    await ctx.answerCallbackQuery({ text: 'Invalid question' })
    return
  }

  // Resolve the answer
  let answerLabel: string
  if (optionValue === 'other') {
    answerLabel = 'Other (please type your answer in chat)'
  } else {
    const optIdx = parseInt(optionValue, 10)
    answerLabel = question.options[optIdx]?.label || `Option ${optIdx + 1}`
  }

  context.answers[questionIndex] = [answerLabel]
  context.answeredCount++

  await ctx.answerCallbackQuery({ text: `Selected: ${answerLabel}` })

  // Check if all questions answered
  if (context.answeredCount >= context.totalQuestions) {
    // Submit answers — each element is an array of selected labels for that question
    const answers = context.questions.map((_, i) => {
      return context.answers[i] || []
    })

    const client = getOpencodeClient(context.directory)
    if (client) {
      await client.question.reply({
        requestID: context.requestId,
        directory: context.directory,
        answers,
      }).catch((error) => {
        logger.error('Failed to submit question answers:', error)
      })
    }

    pendingQuestionContexts.delete(contextHash)
  }
}

// ── Helpers ──────────────────────────────────────────────────────

async function getChatDescription(ctx: Context, chatId: number): Promise<string | undefined> {
  try {
    const chat = await ctx.api.getChat(chatId)
    if ('description' in chat && chat.description) {
      return chat.description
    }
  } catch {
    // Non-critical
  }
  return undefined
}

/**
 * Bind a Telegram supergroup to a project directory.
 * Called from CLI setup or /addproject command.
 */
export async function bindTelegramChat({
  chatId,
  directory,
}: {
  chatId: number | string
  directory: string
}): Promise<void> {
  const channelId = composeTelegramChannelId(chatId)
  await setChannelDirectory({ channelId, directory, channelType: 'text' })
  logger.log(`Bound Telegram chat ${chatId} to directory: ${directory}`)
}

/**
 * Stop the Telegram bot gracefully.
 */
export function stopTelegramBot(bot: Bot): void {
  bot.stop()
  logger.log('Telegram bot stopped')
}
