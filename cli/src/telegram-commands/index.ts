// Telegram command registration and routing.
// Registers bot commands with grammy and the Telegram Bot API.

import type { Bot, Context } from 'grammy'
import { handleAbort } from './abort.js'
import { handleModel } from './model.js'
import { handleAgent } from './agent.js'
import { handleCompact } from './compact.js'
import { handleShare } from './share.js'
import { handleContextUsage } from './context-usage.js'
import { handleSessionId } from './session-id.js'
import { handleUndo, handleRedo } from './undo-redo.js'
import { handleVerbosity } from './verbosity.js'
import { handleRun } from './run.js'
import { handleAddProject } from './add-project.js'
import { handleNewSession } from './newsession.js'
import { handleSkills } from './skills.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.TELEGRAM)

/**
 * Register all Telegram bot commands.
 * Commands are registered both as grammy handlers and via setMyCommands
 * so they appear in Telegram's command menu.
 */
export function registerTelegramCommands(bot: Bot): void {
  bot.command('abort', wrap(handleAbort))
  bot.command('model', wrap(handleModel))
  bot.command('agent', wrap(handleAgent))
  bot.command('compact', wrap(handleCompact))
  bot.command('share', wrap(handleShare))
  bot.command('context', wrap(handleContextUsage))
  bot.command('sessionid', wrap(handleSessionId))
  bot.command('undo', wrap(handleUndo))
  bot.command('redo', wrap(handleRedo))
  bot.command('verbosity', wrap(handleVerbosity))
  bot.command('run', wrap(handleRun))
  bot.command('addproject', wrap(handleAddProject))
  bot.command('newsession', wrap(handleNewSession))
  bot.command('skills', wrap(handleSkills))

  // Register commands in Telegram's menu
  bot.api.setMyCommands([
    { command: 'abort', description: 'Abort the current session' },
    { command: 'model', description: 'Change AI model' },
    { command: 'agent', description: 'Change agent' },
    { command: 'compact', description: 'Compact session context' },
    { command: 'share', description: 'Share session URL' },
    { command: 'context', description: 'Show token usage' },
    { command: 'sessionid', description: 'Show session ID' },
    { command: 'undo', description: 'Undo last assistant action' },
    { command: 'redo', description: 'Redo last undo' },
    { command: 'verbosity', description: 'Set output verbosity' },
    { command: 'run', description: 'Run a shell command' },
    { command: 'addproject', description: 'Bind a project directory' },
    { command: 'newsession', description: 'Start a fresh session' },
    { command: 'skills', description: 'List available skills' },
  ]).catch((err) => {
    logger.error('Failed to register Telegram commands:', err)
  })
}

function wrap(handler: (ctx: Context) => Promise<void>): (ctx: Context) => Promise<void> {
  return async (ctx) => {
    try {
      await handler(ctx)
    } catch (error) {
      logger.error(`Command error: ${error instanceof Error ? error.stack : String(error)}`)
      await ctx.reply(`Error: ${error instanceof Error ? error.message : String(error)}`).catch(() => {})
    }
  }
}
