import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'

// ============ SUPABASE ADMIN CLIENT ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

// ============ AUTHENTICATION ============

function verifyGatewaySecret(request: Request): boolean {
  const secret = process.env.WHATSAPP_GATEWAY_SECRET
  if (!secret) {
    console.error('[web-session/webhook] WHATSAPP_GATEWAY_SECRET is not set — rejecting request.')
    return false
  }
  const header = request.headers.get('x-gateway-secret')
  return header === secret
}

// ============ BAILEYS MESSAGE TYPES ============
// Baileys passes msg.message which is a protobuf-decoded object.
// We only need to extract text content and a few key fields.

interface BaileysMessageKey {
  remoteJid: string | null
  fromMe: boolean
  id: string | null
  participant?: string | null
}

interface BaileysMessageContent {
  conversation?: string
  extendedTextMessage?: { text?: string }
  imageMessage?: { caption?: string }
  videoMessage?: { caption?: string }
  documentMessage?: { caption?: string; fileName?: string }
  audioMessage?: Record<string, unknown>
  locationMessage?: { degreesLatitude?: number; degreesLongitude?: number; name?: string; address?: string }
}

interface BaileysMessage {
  key: BaileysMessageKey
  message?: BaileysMessageContent | null
  messageTimestamp?: number | string | null
  pushName?: string | null
}

// ============ HELPERS ============

/**
 * Extract plain text from a Baileys decoded message object.
 * Only handles the most common content types.
 */
function extractTextFromBaileysMessage(
  msg: BaileysMessage
): { contentText: string | null; contentType: string } {
  const m = msg.message
  if (!m) return { contentText: null, contentType: 'text' }

  if (m.conversation) {
    return { contentText: m.conversation, contentType: 'text' }
  }

  if (m.extendedTextMessage?.text) {
    return { contentText: m.extendedTextMessage.text, contentType: 'text' }
  }

  if (m.imageMessage) {
    return { contentText: m.imageMessage.caption || null, contentType: 'image' }
  }

  if (m.videoMessage) {
    return { contentText: m.videoMessage.caption || null, contentType: 'video' }
  }

  if (m.documentMessage) {
    return {
      contentText: m.documentMessage.caption || m.documentMessage.fileName || null,
      contentType: 'document',
    }
  }

  if (m.audioMessage) {
    return { contentText: null, contentType: 'audio' }
  }

  if (m.locationMessage) {
    const loc = m.locationMessage
    const parts = [loc.name, loc.address, `${loc.degreesLatitude},${loc.degreesLongitude}`].filter(Boolean)
    return { contentText: parts.join(' - '), contentType: 'location' }
  }

  return { contentText: '[Unsupported message type]', contentType: 'text' }
}

/**
 * Parse a WhatsApp JID (JID = phone@s.whatsapp.net or group@g.us) to extract a phone number.
 * Returns the numeric portion, or null for non-user JIDs (groups, status, etc.)
 */
function jidToPhone(jid: string | null): string | null {
  if (!jid) return null
  if (jid.endsWith('@g.us') || jid.endsWith('@broadcast')) return null
  const [phone] = jid.split('@')
  return phone || null
}

// ============ CONTACT / CONVERSATION HELPERS ============

interface ContactOutcome {
  contact: Record<string, unknown>
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  const existingContact = await findExistingContact(supabaseAdmin(), accountId, phone)

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact as Record<string, unknown>, wasCreated: false }
  }

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced as Record<string, unknown>, wasCreated: false }
    }
    console.error('[web-session/webhook] Error creating contact:', createError)
    return null
  }

  return { contact: newContact as Record<string, unknown>, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string
): Promise<Record<string, unknown> | null> {
  const { data: existing, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .single()

  if (!findError && existing) {
    return existing as Record<string, unknown>
  }

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
      channel: 'whatsapp',
    })
    .select()
    .single()

  if (createError) {
    console.error('[web-session/webhook] Error creating conversation:', createError)
    return null
  }

  return newConv as Record<string, unknown>
}

// ============ EVENT PROCESSORS ============

async function handleConnectionStatus(
  accountId: string,
  status: string,
  qr: string | undefined
) {
  // Simply log the connection update.
  // UI polling will retrieve the current state from the gateway.
  console.log(`[web-session/webhook] Account ${accountId} connection status: ${status}`)
  if (qr) {
    console.log(`[web-session/webhook] QR code available for account ${accountId}`)
  }
  // Future: broadcast realtime updates via Supabase channel here
}

async function handleInboundMessage(
  accountId: string,
  rawMsg: BaileysMessage
) {
  const key = rawMsg.key

  // Skip messages sent by us (fromMe=true = outgoing from the linked phone)
  // We only process inbound customer messages here.
  if (key.fromMe) return

  // Extract sender JID
  const senderJid = key.remoteJid
  const rawPhone = jidToPhone(senderJid)
  if (!rawPhone) {
    console.log('[web-session/webhook] Skipping non-user JID:', senderJid)
    return
  }

  const senderPhone = normalizePhone(rawPhone)
  const senderName = rawMsg.pushName || senderPhone
  const messageId = key.id || `baileys-${Date.now()}`
  const { contentText, contentType } = extractTextFromBaileysMessage(rawMsg)

  // Timestamp: Baileys provides Unix epoch
  const ts = rawMsg.messageTimestamp
  const messageTimestamp = ts
    ? new Date(Number(ts) * 1000).toISOString()
    : new Date().toISOString()

  // ============ RESOLVE ACCOUNT OWNER (configOwnerUserId) ============
  // We need a user_id for NOT NULL FK columns (contacts, conversations).
  // We look it up from whatsapp_config where account_id matches, then
  // fall back to the first member of the account if whatsapp_config doesn't exist.

  const { data: configRow } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('user_id')
    .eq('account_id', accountId)
    .maybeSingle()

  let configOwnerUserId: string | null = configRow?.user_id || null

  if (!configOwnerUserId) {
    const { data: memberRow } = await supabaseAdmin()
      .from('account_members')
      .select('user_id')
      .eq('account_id', accountId)
      .eq('role', 'admin')
      .limit(1)
      .single()
    configOwnerUserId = memberRow?.user_id || null
  }

  if (!configOwnerUserId) {
    console.error(`[web-session/webhook] No owner user found for account ${accountId}. Dropping message.`)
    return
  }

  // ============ FIND / CREATE CONTACT ============
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    senderName
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  // ============ FIND / CREATE CONVERSATION ============
  const conversation = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id as string
  )
  if (!conversation) return

  // ============ CHECK FIRST INBOUND ============
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  // ============ INSERT MESSAGE ============
  const ALLOWED_CONTENT_TYPES = new Set(['text', 'image', 'document', 'audio', 'video', 'location', 'template', 'interactive'])
  const dbContentType = ALLOWED_CONTENT_TYPES.has(contentType) ? contentType : 'text'

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: dbContentType,
    content_text: contentText,
    message_id: messageId,
    status: 'delivered',
    channel: 'whatsapp',
    created_at: messageTimestamp,
  })

  if (msgError) {
    // Duplicate message_id (e.g. gateway retried) — not a fatal error
    if (msgError.code === '23505') {
      console.log(`[web-session/webhook] Duplicate message ${messageId} skipped`)
      return
    }
    console.error('[web-session/webhook] Error inserting message:', msgError)
    return
  }

  // ============ UPDATE CONVERSATION ============
  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${contentType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: ((conversation.unread_count as number) || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('[web-session/webhook] Error updating conversation:', convError)
  }

  // ============ FLOWS + AUTOMATIONS DISPATCH ============
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id as string,
    conversationId: conversation.id as string,
    message: {
      kind: 'text',
      text: contentText ?? '',
      meta_message_id: messageId,
    },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const inboundText = contentText ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = []

  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')

  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id as string,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id as string,
      },
    }).catch((err) => console.error('[web-session/webhook] automation dispatch failed:', err))
  }

  console.log(`[web-session/webhook] Processed inbound message ${messageId} for account ${accountId}`)
}

// ============ POST HANDLER ============

export async function POST(request: Request) {
  // 1. Verify that the request came from our trusted sidecar gateway
  if (!verifyGatewaySecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const accountId = body.accountId as string | undefined
  const eventType = body.type as string | undefined

  if (!accountId || !eventType) {
    return NextResponse.json({ error: 'accountId and type are required' }, { status: 400 })
  }

  // Process event types asynchronously — always respond 200 OK quickly
  // to not block the gateway's forwarding loop.
  ;(async () => {
    try {
      if (eventType === 'connection.status') {
        await handleConnectionStatus(
          accountId,
          body.status as string,
          body.qr as string | undefined
        )
      } else if (eventType === 'messages.upsert') {
        await handleInboundMessage(accountId, body.message as BaileysMessage)
      } else {
        console.log(`[web-session/webhook] Unhandled event type: ${eventType}`)
      }
    } catch (err) {
      console.error(`[web-session/webhook] Unhandled error processing event ${eventType}:`, err)
    }
  })()

  return NextResponse.json({ ok: true })
}
