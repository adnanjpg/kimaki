import type { Context } from 'grammy'
import { resolveContext } from './resolve.js'
import { execAsync } from '../worktrees.js'

export async function handleRun(ctx: Context): Promise<void> {
  const resolved = await resolveContext(ctx)
  if (!resolved) return

  const command = (ctx.message?.text || '').replace(/^\/run\s*/i, '').trim()
  if (!command) {
    await ctx.reply('Usage: /run <command>\nExample: /run git status')
    return
  }

  const loadingMsg = await ctx.reply(`Running \`${command.slice(0, 200)}\`...`, {
    parse_mode: 'Markdown',
  })

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: resolved.projectDirectory,
      timeout: 30000,
    })

    const output = (stdout || '') + (stderr ? `\nstderr:\n${stderr}` : '')
    const truncated = output.length > 3900
      ? output.slice(0, 3900) + '\n... (truncated)'
      : output

    await ctx.api.editMessageText(
      ctx.chat!.id,
      loadingMsg.message_id,
      `<pre>${escapeHtml(truncated || '(no output)')}</pre>`,
      { parse_mode: 'HTML' },
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loadingMsg.message_id,
      `Command failed: ${msg.slice(0, 3900)}`,
    )
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
