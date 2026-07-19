import type { ChatMessage } from './types'

/**
 * Robustly extract string content from any ChatMessage content block format.
 */
export function getMessageText(content: ChatMessage['content']): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join(' ')
}

/**
 * The text to retrieve knowledge against: the most recent customer
 * (`user`) turn in the conversation context. Falls back to the last
 * message of any role, then empty string. Shared by the draft route and
 * the auto-reply bot so both query the knowledge base the same way.
 */
export function latestUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const text = getMessageText(messages[i].content)
      if (text) return text
    }
  }
  return messages.length > 0 ? getMessageText(messages[messages.length - 1].content) : ''
}
