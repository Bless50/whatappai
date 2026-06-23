import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchToAIAgent, pauseAI } from '@/lib/ai/agent-dispatcher'


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

// ============ BAILEYS UNWRAPPERS & FILTERS ============

const PROTOCOL_MESSAGE_TYPES = new Set([
  'senderKeyDistributionMessage',
  'protocolMessage',
  'historySyncNotification',
  'peerDataOperationRequestMessage',
  'reactionMessage',
])

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrapBaileysMessage(m: any): any {
  if (!m) return m
  if (m.ephemeralMessage?.message) return unwrapBaileysMessage(m.ephemeralMessage.message)
  if (m.viewOnceMessage?.message) return unwrapBaileysMessage(m.viewOnceMessage.message)
  if (m.viewOnceMessageV2?.message) return unwrapBaileysMessage(m.viewOnceMessageV2.message)
  if (m.documentWithCaptionMessage?.message) return unwrapBaileysMessage(m.documentWithCaptionMessage.message)
  if (m.deviceSentMessage?.message) return unwrapBaileysMessage(m.deviceSentMessage.message)
  if (m.editedMessage?.message) return unwrapBaileysMessage(m.editedMessage.message)
  if (m.protocolMessage?.editedMessage) return unwrapBaileysMessage(m.protocolMessage.editedMessage)
  return m
}

/**
 * Extract plain text from a Baileys decoded message object.
 * Only handles the most common content types.
 */
function extractTextFromBaileysMessage(
  msg: BaileysMessage
): { contentText: string | null; contentType: string } {
  const m = unwrapBaileysMessage(msg.message)
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

  if (m.stickerMessage) {
    return { contentText: '[Sticker]', contentType: 'image' }
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
  const [userPart] = jid.split('@')
  const [phone] = userPart.split(':')
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
  console.log(`[web-session/webhook] Account ${accountId} connection status: ${status}`)
  if (qr) {
    console.log(`[web-session/webhook] QR code available for account ${accountId}`)
  }

  const dbStatus = status === 'connected' ? 'connected' : 'disconnected'

  // Resolve config owner user id
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
      .maybeSingle()
    configOwnerUserId = memberRow?.user_id || null
  }

  if (!configOwnerUserId) {
    const { data: accountRow } = await supabaseAdmin()
      .from('accounts')
      .select('owner_user_id')
      .eq('id', accountId)
      .maybeSingle()
    configOwnerUserId = accountRow?.owner_user_id || null
  }

  if (!configOwnerUserId) {
    const { data: profileRow } = await supabaseAdmin()
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId)
      .limit(1)
      .maybeSingle()
    configOwnerUserId = profileRow?.user_id || null
  }

  if (!configOwnerUserId) {
    console.error(`[web-session/webhook] No owner user found for account ${accountId}. Cannot sync connection status.`)
    return
  }

  const { data: existingConfig } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', accountId)
    .maybeSingle()

  if (!existingConfig) {
    const encryptedPlaceholder = encrypt('linked-phone-placeholder')
    const { error: insertErr } = await supabaseAdmin()
      .from('whatsapp_config')
      .insert({
        account_id: accountId,
        user_id: configOwnerUserId,
        phone_number_id: 'linked-phone',
        access_token: encryptedPlaceholder,
        status: dbStatus,
        connected_at: dbStatus === 'connected' ? new Date().toISOString() : null,
      })
    if (insertErr) {
      console.error('[web-session/webhook] Failed to insert placeholder whatsapp_config:', insertErr)
    } else {
      console.log(`[web-session/webhook] Created placeholder config for account ${accountId} (status: ${dbStatus})`)
    }
  } else {
    const { error: updateErr } = await supabaseAdmin()
      .from('whatsapp_config')
      .update({
        phone_number_id: 'linked-phone',
        status: dbStatus,
        connected_at: dbStatus === 'connected' ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', accountId)
    if (updateErr) {
      console.error('[web-session/webhook] Failed to update whatsapp_config status:', updateErr)
    } else {
      console.log(`[web-session/webhook] Updated config status to ${dbStatus} for account ${accountId}`)
    }
  }
}


async function handleInboundMessage(
  accountId: string,
  rawMsg: BaileysMessage
) {
  const key = rawMsg.key

  // Extract sender JID
  const senderJid = key.remoteJid
  const rawPhone = jidToPhone(senderJid)
  if (!rawPhone) {
    console.log('[web-session/webhook] Skipping non-user JID:', senderJid)
    return
  }

  const senderPhone = normalizePhone(rawPhone)
  const senderName = key.fromMe ? '' : (rawMsg.pushName || senderPhone)
  const messageId = key.id || `baileys-${Date.now()}`

  // Unwrap any message wrappers (ephemeral, viewOnce, deviceSent, etc.)
  const unwrappedMessage = unwrapBaileysMessage(rawMsg.message)
  
  // If there's no message content, or if it is a protocol/background message, skip it!
  if (!unwrappedMessage) {
    console.log('[web-session/webhook] Skipping message with no content:', messageId)
    return
  }

  // Check if it's a protocol message we should skip (key distribution, history sync, reaction, etc.)
  const messageKeys = Object.keys(unwrappedMessage)
  const isProtocolMessage = messageKeys.some(k => PROTOCOL_MESSAGE_TYPES.has(k))
  if (isProtocolMessage) {
    console.log('[web-session/webhook] Skipping protocol message:', messageId, messageKeys)
    return
  }

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
    .select('user_id, access_token')
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
      .maybeSingle()
    configOwnerUserId = memberRow?.user_id || null
  }

  if (!configOwnerUserId) {
    const { data: accountRow } = await supabaseAdmin()
      .from('accounts')
      .select('owner_user_id')
      .eq('id', accountId)
      .maybeSingle()
    configOwnerUserId = accountRow?.owner_user_id || null
  }

  if (!configOwnerUserId) {
    const { data: profileRow } = await supabaseAdmin()
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId)
      .limit(1)
      .maybeSingle()
    configOwnerUserId = profileRow?.user_id || null
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

  const ALLOWED_CONTENT_TYPES = new Set(['text', 'image', 'document', 'audio', 'video', 'location', 'template', 'interactive'])
  const dbContentType = ALLOWED_CONTENT_TYPES.has(contentType) ? contentType : 'text'

  // ============ HANDLE OUTBOUND MESSAGES (FROM PHONE) ============
  if (key.fromMe) {
    // Wait 2 seconds to let the CRM or AI engine insert the message first if they sent it
    await new Promise((resolve) => setTimeout(resolve, 2000))

    // Check if the message is already in the database
    const { data: existingMsg } = await supabaseAdmin()
      .from('messages')
      .select('id')
      .eq('message_id', messageId)
      .maybeSingle()

    if (existingMsg) {
      // It was sent by the CRM or AI, so they already handled it and saved it.
      console.log(`[web-session/webhook] Duplicate outbound message ${messageId} skipped (handled by CRM/AI)`)
      return
    }

    // If we reach here, the message was typed physically on the user's phone or WhatsApp Web
    const { error: msgError } = await supabaseAdmin().from('messages').insert({
      conversation_id: conversation.id,
      sender_type: 'agent',
      content_type: dbContentType,
      content_text: contentText,
      message_id: messageId,
      status: 'sent',
      channel: 'whatsapp',
      created_at: messageTimestamp,
    })

    if (msgError) {
      if (msgError.code === '23505') return
      console.error('[web-session/webhook] Error inserting phone message:', msgError)
      return
    }

    // Update conversation
    await supabaseAdmin()
      .from('conversations')
      .update({
        last_message_text: contentText || `[${contentType}]`,
        last_message_at: new Date().toISOString(),
        unread_count: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation.id)

    // Pause the AI since the business owner has taken over directly from their phone
    if (conversation.ai_status !== 'disabled') {
      try {
        await pauseAI(conversation.id as string, conversation.ai_agent_id)
        console.log(`[web-session/webhook] AI agent paused because owner sent message from phone.`)
      } catch (err) {
        console.error('[web-session/webhook] pauseAI threw:', err)
      }
    }

    console.log(`[web-session/webhook] Processed outbound phone message ${messageId} for account ${accountId}`)
    return
  }

  // ============ INSERT INBOUND MESSAGE ============
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
      console.log(`[web-session/webhook] Duplicate inbound message ${messageId} skipped`)
      return
    }
    console.error('[web-session/webhook] Error inserting inbound message:', msgError)
    return
  }

  // ============ UPDATE CONVERSATION (INBOUND) ============
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

  // ============ AI AGENT DISPATCH ============
  if (!flowConsumed) {
    const rawToken = configRow?.access_token || ''
    const decryptedAccessToken = rawToken ? decrypt(rawToken) : ''

    dispatchToAIAgent({
      accountId,
      conversationId: conversation.id as string,
      contactId: contactRecord.id as string,
      messageText: inboundText,
      userId: configOwnerUserId,
      accessToken: decryptedAccessToken,
      channel: 'whatsapp',
    }).catch((err) => console.error('[web-session/webhook] AI agent dispatch failed:', err))
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
