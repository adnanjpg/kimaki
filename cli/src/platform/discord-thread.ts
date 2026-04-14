// DiscordThread — wraps a discord.js ThreadChannel to implement PlatformThread.
// All Discord-specific rendering (markdown pipeline, component construction,
// message splitting at 2000 chars) lives here.

import * as discord from 'discord.js'
import type { ThreadChannel } from 'discord.js'
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, StringSelectMenuBuilder } = discord
import {
  sendThreadMessage,
  SILENT_MESSAGE_FLAGS,
  NOTIFY_MESSAGE_FLAGS,
} from '../discord-utils.js'
import * as errore from 'errore'
import type {
  PlatformThread,
  SendOptions,
  EditOptions,
  SendResult,
  ButtonStyle as PlatformButtonStyle,
} from './types.js'

function discordButtonStyle(style: PlatformButtonStyle): discord.ButtonStyle {
  switch (style) {
    case 'primary':
      return ButtonStyle.Primary
    case 'success':
      return ButtonStyle.Success
    case 'danger':
      return ButtonStyle.Danger
    case 'secondary':
    default:
      return ButtonStyle.Secondary
  }
}

function resolveFlags(preset?: 'silent' | 'notify'): number {
  if (preset === 'notify') {
    return NOTIFY_MESSAGE_FLAGS
  }
  return SILENT_MESSAGE_FLAGS
}

export class DiscordThread implements PlatformThread {
  readonly platform = 'discord' as const
  private readonly threadChannel: ThreadChannel

  constructor(threadChannel: ThreadChannel) {
    this.threadChannel = threadChannel
  }

  get id(): string {
    return this.threadChannel.id
  }

  get name(): string {
    return this.threadChannel.name
  }

  get parentChannelId(): string | undefined {
    return this.threadChannel.parentId || undefined
  }

  get serverId(): string {
    return this.threadChannel.guildId
  }

  get createdTimestamp(): number | null {
    return this.threadChannel.createdTimestamp
  }

  /**
   * Expose the underlying ThreadChannel for code that still needs direct
   * Discord API access (e.g. interaction handlers, forum sync).
   */
  get raw(): ThreadChannel {
    return this.threadChannel
  }

  async send(content: string, options?: SendOptions): Promise<SendResult> {
    const flags = resolveFlags(options?.flags)

    // When components (buttons/menus) are requested, send directly with them.
    // Component messages are short and don't need the full markdown pipeline.
    if (options?.buttons?.length || options?.selectMenus?.length) {
      const components: discord.ActionRowBuilder<discord.MessageActionRowComponentBuilder>[] = []

      if (options.buttons?.length) {
        const row = new ActionRowBuilder<discord.ButtonBuilder>().addComponents(
          ...options.buttons.map((btn) => {
            return new ButtonBuilder()
              .setCustomId(btn.customId)
              .setLabel(btn.label)
              .setStyle(discordButtonStyle(btn.style))
          }),
        )
        components.push(row)
      }

      if (options.selectMenus?.length) {
        for (const menu of options.selectMenus) {
          const select = new StringSelectMenuBuilder()
            .setCustomId(menu.customId)
            .setPlaceholder(menu.placeholder)
            .addOptions(
              menu.options.map((opt) => ({
                label: opt.label.slice(0, 100),
                value: opt.value,
                ...(opt.description ? { description: opt.description.slice(0, 100) } : {}),
              })),
            )
          if (menu.minValues !== undefined) {
            select.setMinValues(menu.minValues)
          }
          if (menu.maxValues !== undefined) {
            select.setMaxValues(menu.maxValues)
          }
          components.push(
            new ActionRowBuilder<discord.StringSelectMenuBuilder>().addComponents(select),
          )
        }
      }

      const message = await this.threadChannel.send({
        content: content.slice(0, 1900),
        components,
        flags: flags | MessageFlags.SuppressEmbeds,
      })
      return { id: message.id }
    }

    // Standard content send — use the full Discord markdown pipeline
    // (table extraction, code block escaping, heading depth, 2000-char split)
    const message = await sendThreadMessage(this.threadChannel, content, { flags })
    return { id: message.id }
  }

  async edit(messageId: string, options: EditOptions): Promise<void> {
    const message = await this.threadChannel.messages.fetch(messageId)
    const clearComponents = options.clearComponents !== false
    await message.edit({
      content: options.content,
      ...(clearComponents ? { components: [] } : {}),
    })
  }

  async sendTyping(): Promise<void> {
    await this.threadChannel.sendTyping()
  }

  async setName(name: string): Promise<void> {
    await this.threadChannel.setName(name)
  }

  async getParentTopic(channelId?: string): Promise<string | undefined> {
    // If no specific channel requested, use the parent channel
    if (!channelId) {
      if (this.threadChannel.parent?.type === ChannelType.GuildText) {
        return this.threadChannel.parent.topic?.trim() || undefined
      }
      return undefined
    }

    // Fetch a specific channel by ID
    const fetched = await errore.tryAsync(() => {
      return this.threadChannel.guild.channels.fetch(channelId)
    })
    if (fetched instanceof Error || !fetched) {
      return undefined
    }
    if (fetched.type !== ChannelType.GuildText) {
      return undefined
    }
    return fetched.topic?.trim() || undefined
  }
}
