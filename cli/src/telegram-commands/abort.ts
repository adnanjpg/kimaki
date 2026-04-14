import type { Context } from 'grammy'
import { resolveContext, getClient } from './resolve.js'
import { getRuntime } from '../session-handler/thread-session-runtime.js'

export async function handleAbort(ctx: Context): Promise<void> {
  const resolved = await resolveContext(ctx)
  if (!resolved) return

  const runtime = getRuntime(resolved.threadId)
  if (runtime) {
    runtime.abortActiveRun('user /abort command')
  }

  if (resolved.sessionId) {
    const client = await getClient(ctx, resolved.projectDirectory)
    if (client) {
      await client.session.abort({
        sessionID: resolved.sessionId,
        directory: resolved.projectDirectory,
      }).catch(() => {})
    }
  }

  await ctx.reply('Request **aborted**', { parse_mode: 'Markdown' })
}
