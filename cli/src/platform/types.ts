// Platform abstraction types for multi-platform support (Discord, Telegram).
// PlatformThread is the minimal interface that ThreadSessionRuntime and
// command modules (permissions, ask-question, action-buttons) need from a
// thread/topic handle. Each platform implements this interface.

export type PlatformType = 'discord' | 'telegram'

export type MessageFlagPreset = 'silent' | 'notify'

export type ButtonStyle = 'primary' | 'secondary' | 'success' | 'danger'

export type PlatformButton = {
  customId: string
  label: string
  style: ButtonStyle
}

export type PlatformSelectMenu = {
  customId: string
  placeholder: string
  options: Array<{ label: string; value: string; description?: string }>
  minValues?: number
  maxValues?: number
}

export type SendOptions = {
  flags?: MessageFlagPreset
  buttons?: PlatformButton[]
  selectMenus?: PlatformSelectMenu[]
  files?: Array<{ filename: string; data: Buffer; contentType?: string }>
  metadata?: Record<string, unknown>
}

export type EditOptions = {
  content: string
  /** Clear all components when set to true (default: true). */
  clearComponents?: boolean
}

export type SendResult = {
  id: string
}

/**
 * Platform-agnostic thread handle.
 *
 * Represents a Discord thread or Telegram forum topic. The runtime and
 * command modules interact with this interface exclusively — platform-specific
 * rendering (markdown pipeline, component construction, message splitting)
 * lives inside each implementation.
 */
export interface PlatformThread {
  readonly id: string
  readonly name: string
  readonly parentChannelId: string | undefined
  readonly serverId: string
  readonly createdTimestamp: number | null
  readonly platform: PlatformType

  /**
   * Send a markdown message. The implementation handles the full rendering
   * pipeline for its platform (splitting, formatting, component construction).
   * Returns the ID of the first message sent.
   */
  send(content: string, options?: SendOptions): Promise<SendResult>

  /**
   * Edit an existing message. Used by permission/action button cleanup
   * to strip components and update status text.
   */
  edit(messageId: string, options: EditOptions): Promise<void>

  /** Send typing indicator. Platform determines duration/keepalive. */
  sendTyping(): Promise<void>

  /** Rename the thread (Discord) or forum topic (Telegram). */
  setName(name: string): Promise<void>

  /**
   * Get the parent channel's topic string (used for system message context).
   * If channelId is provided, fetches that channel's topic instead.
   */
  getParentTopic(channelId?: string): Promise<string | undefined>
}
