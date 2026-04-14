import type { Context } from 'grammy'
import { resolveContext, getClient } from './resolve.js'

export async function handleSkills(ctx: Context): Promise<void> {
  const resolved = await resolveContext(ctx)
  if (!resolved) return

  const client = await getClient(ctx, resolved.projectDirectory)
  if (!client) return

  const commandsResult = await client.command.list({ directory: resolved.projectDirectory })
  const skills = (commandsResult.data || []).filter((c) => c.source === 'skill')

  if (skills.length === 0) {
    await ctx.reply('No skills available.')
    return
  }

  const names = skills.map((s) => `\`/${s.name}\``).join(', ')

  await ctx.reply(
    `**Skills (${skills.length}):** ${names}`,
    { parse_mode: 'Markdown' },
  )
}
