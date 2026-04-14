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

  const header = `**Available skills (${skills.length}):**\n\n`
  const MAX_LEN = 4000 // leave room for header + safety margin

  const lines: string[] = []
  let totalLen = header.length
  for (const s of skills) {
    const desc = s.description ? ` — ${s.description}` : ''
    const line = `• \`/${s.name}\`${desc}`
    if (totalLen + line.length + 1 > MAX_LEN) {
      lines.push(`… and ${skills.length - lines.length} more`)
      break
    }
    lines.push(line)
    totalLen += line.length + 1
  }

  await ctx.reply(
    `${header}${lines.join('\n')}`,
    { parse_mode: 'Markdown' },
  )
}
