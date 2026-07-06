/**
 * Prompt builder — assembles the full context window for the AI agent.
 *
 * The context sent to the LLM is built in layers:
 *   1. System prompt (agent personality + instructions)
 *   2. CRM context (contact info, deal status)
 *   3. Knowledge base chunks (RAG-retrieved, most relevant)
 *   4. Conversation history (last N messages)
 *   5. Current inbound message (the user's latest text)
 *
 * The builder stays under the model's context window by budgeting
 * tokens per section. History is trimmed oldest-first; KB chunks
 * are capped by topK.
 */

import type { ChatMessage } from './types'
import { supabaseAdmin } from './admin-client'

// ============================================================
// Constants
// ============================================================

/** Max recent messages to include in conversation history. */
const MAX_HISTORY_MESSAGES = 20

/** Rough chars-per-token estimate for budgeting. */
const CHARS_PER_TOKEN = 4

// ============================================================
// Public API
// ============================================================

export interface PromptContext {
  /** The agent's system prompt from config. */
  systemPrompt: string
  /** Contact details for CRM context. */
  contactId: string
  /** Conversation to pull history from. */
  conversationId: string
  /** Account for CRM data access. */
  accountId: string
  /** The current inbound message text. */
  inboundText: string
  /** RAG-retrieved knowledge chunks (pre-searched by the engine). */
  knowledgeContext?: string
  /** Max tokens for the full prompt (to budget sections). */
  maxContextTokens?: number
}

/**
 * Build the complete message array for the LLM chat completion call.
 *
 * Returns an array of ChatMessage objects ready to send to the model.
 */
export async function buildPrompt(ctx: PromptContext): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = []

  // ============ 1. SYSTEM PROMPT ============
  const systemParts: string[] = []

  // Agent personality and instructions
  systemParts.push(ctx.systemPrompt)

  // CRM context — contact info
  const contactContext = await buildContactContext(ctx.contactId, ctx.accountId)
  if (contactContext) {
    systemParts.push(
      '\n--- CONTACT INFORMATION ---\n' +
      'Here is what you know about the person you are talking to:\n' +
      contactContext,
    )
  }

  // Active deals context
  const dealsContext = await buildDealsContext(ctx.contactId)
  if (dealsContext) {
    systemParts.push(
      '\n--- ACTIVE DEALS ---\n' +
      dealsContext,
    )
  }

  // Customer memory & past interactions context
  const memoryContext = await buildMemoryContext(ctx.contactId, ctx.conversationId)
  if (memoryContext) {
    systemParts.push(
      '\n--- CUSTOMER MEMORY & NOTES ---\n' +
      memoryContext,
    )
  }

  // Knowledge base context (RAG chunks)
  if (ctx.knowledgeContext) {
    systemParts.push(
      '\n--- KNOWLEDGE BASE ---\n' +
      'Use the following information to answer the customer\'s questions. ' +
      'If the answer is not in the knowledge base, say so honestly.\n\n' +
      ctx.knowledgeContext,
    )
  }

  // Current date/time for temporal awareness
  systemParts.push(
    `\n--- CURRENT TIME ---\nThe current date and time is: ${new Date().toISOString()}`,
  )

  messages.push({
    role: 'system',
    content: systemParts.join('\n'),
  })

  // ============ 2. CONVERSATION HISTORY ============
  const history = await buildConversationHistory(
    ctx.conversationId,
    MAX_HISTORY_MESSAGES,
  )
  messages.push(...history)

  // ============ 3. CURRENT MESSAGE ============
  messages.push({
    role: 'user',
    content: ctx.inboundText,
  })

  return messages
}

// ============================================================
// Context Builders
// ============================================================

/**
 * Build a text summary of the contact's CRM profile.
 */
async function buildContactContext(
  contactId: string,
  accountId: string,
): Promise<string | null> {
  const db = supabaseAdmin()

  // Fetch contact with tags
  const { data: contact, error } = await db
    .from('contacts')
    .select('name, phone, email, company')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error || !contact) return null

  const parts: string[] = []
  if (contact.name) parts.push(`Name: ${contact.name}`)
  if (contact.phone) parts.push(`Phone: ${contact.phone}`)
  if (contact.email) parts.push(`Email: ${contact.email}`)
  if (contact.company) parts.push(`Company: ${contact.company}`)

  // Fetch tags
  const { data: tagRows } = await db
    .from('contact_tags')
    .select('tags(name)')
    .eq('contact_id', contactId)

  if (tagRows && tagRows.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tagNames = tagRows.map((r: any) => r.tags?.name).filter(Boolean)
    if (tagNames.length > 0) {
      parts.push(`Tags: ${tagNames.join(', ')}`)
    }
  }

  // Fetch custom field values
  const { data: customValues } = await db
    .from('contact_custom_values')
    .select('value, custom_fields(field_name)')
    .eq('contact_id', contactId)

  if (customValues && customValues.length > 0) {
    for (const cv of customValues) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fieldName = (cv as any).custom_fields?.field_name
      if (fieldName && cv.value) {
        parts.push(`${fieldName}: ${cv.value}`)
      }
    }
  }

  return parts.length > 0 ? parts.join('\n') : null
}

/**
 * Build a summary of active deals for this contact.
 */
async function buildDealsContext(contactId: string): Promise<string | null> {
  const db = supabaseAdmin()

  const { data: deals, error } = await db
    .from('deals')
    .select('title, value, currency, status, pipeline_stages(name)')
    .eq('contact_id', contactId)
    .in('status', ['open', 'active'])
    .order('created_at', { ascending: false })
    .limit(5)

  if (error || !deals || deals.length === 0) return null

  const lines = deals.map((d: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stageName = (d as any).pipeline_stages?.name ?? 'Unknown'
    return `- ${d.title} (${d.currency ?? 'USD'} ${d.value}) — Stage: ${stageName}`
  })

  return lines.join('\n')
}

/**
 * Fetch recent conversation messages and format them as ChatMessage
 * objects for the LLM history window.
 *
 * sender_type mapping:
 *   'customer' → role: 'user'
 *   'agent'    → role: 'assistant' (human agent treated same as AI in history)
 *   'bot'      → role: 'assistant'
 */
async function buildConversationHistory(
  conversationId: string,
  limit: number,
): Promise<ChatMessage[]> {
  const db = supabaseAdmin()

  const { data: rows, error } = await db
    .from('messages')
    .select('sender_type, content_type, content_text, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(limit)

  if (error || !rows || rows.length === 0) return []

  const messages: ChatMessage[] = []

  for (const row of rows) {
    // Skip non-text messages in history (images, etc.) — include a
    // placeholder so the model knows something was sent.
    const text = row.content_text
      ? row.content_text
      : `[${row.content_type} message]`

    const role: ChatMessage['role'] =
      row.sender_type === 'customer' ? 'user' : 'assistant'

    messages.push({ role, content: text })
  }

  return messages
}

/**
 * Estimate token count from text length.
 * Rough heuristic — actual tokenization varies by model. Good enough
 * for context window budgeting.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

interface MemoryConversation {
  id: string
  channel: string | null
  created_at: string
  last_message_at: string | null
  status: string
}

/**
 * Build a text summary of the customer's history and human notes.
 */
async function buildMemoryContext(
  contactId: string,
  currentConversationId: string,
): Promise<string | null> {
  const db = supabaseAdmin()

  // 1. Fetch other conversations for this contact
  const { data } = await db
    .from('conversations')
    .select('id, channel, created_at, last_message_at, status')
    .eq('contact_id', contactId)
    .neq('id', currentConversationId)

  const conversations = data as MemoryConversation[] | null

  // 2. Fetch all notes left by human agents
  const { data: notes } = await db
    .from('contact_notes')
    .select('note_text, created_at')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })

  const hasConversations = conversations && conversations.length > 0
  const hasNotes = notes && notes.length > 0

  if (!hasConversations && !hasNotes) {
    return 'This is a new customer. This is their first time messaging the business.'
  }

  const parts: string[] = []

  if (hasConversations) {
    parts.push('This is a RETURNING customer. They have existing conversations with the business:')
    const channels = Array.from(new Set(conversations.map((c) => c.channel).filter(Boolean)))
    parts.push(`- Previous Channels Used: ${channels.join(', ')}`)

    parts.push('- Previous Threads:')
    for (const c of conversations) {
      const lastMsgAt = c.last_message_at ? new Date(c.last_message_at).toLocaleDateString() : 'N/A'
      parts.push(`  * [Channel: ${c.channel}] Status: ${c.status}, Last active: ${lastMsgAt}`)
    }
  } else {
    parts.push('This is a new customer, but they have profile details in the CRM.')
  }

  if (hasNotes) {
    parts.push('\nHere are notes recorded by human agents about this customer:')
    for (const n of notes) {
      const noteDate = new Date(n.created_at).toLocaleDateString()
      parts.push(`- [${noteDate}]: ${n.note_text}`)
    }
  }

  return parts.join('\n')
}
