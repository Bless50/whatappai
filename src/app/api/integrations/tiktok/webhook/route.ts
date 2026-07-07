/**
 * TikTok Business API webhook handler.
 *
 * Receives real-time events from TikTok when:
 *   - A user comments on a Business Account's video
 *   - A user sends a direct message to the Business Account
 *
 * Architecture mirrors the Facebook/Instagram webhook at
 * /api/integrations/facebook/webhook — same contact/conversation
 * resolution, message insertion, and AI agent dispatch flow.
 *
 * Setup:
 *   1. Register this URL as a webhook in the TikTok Developer Portal
 *   2. Set TIKTOK_WEBHOOK_VERIFY_TOKEN in .env.local
 *   3. Connect the TikTok Business Account in CRM Settings
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { dispatchToAIAgent, pauseAI } from '@/lib/ai/agent-dispatcher'

// ============================================================
// Supabase Admin Client (lazy init)
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _admin: any = null
function supabaseAdmin() {
  if (!_admin) {
    _admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _admin
}

// ============================================================
// Types
// ============================================================

/** TikTok webhook event for a new comment on a video. */
interface TikTokCommentEvent {
  type: 'comment'
  comment_id: string
  video_id: string
  text: string
  user_open_id: string
  user_display_name?: string
  create_time: number
}

/** TikTok webhook event for a new direct message. */
interface TikTokMessageEvent {
  type: 'message'
  message_id: string
  text: string
  sender_open_id: string
  sender_display_name?: string
  create_time: number
}

interface TikTokWebhookPayload {
  event: string
  business_id: string
  content: TikTokCommentEvent | TikTokMessageEvent
}

// ============================================================
// GET — Webhook Verification
// ============================================================

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const challenge = searchParams.get('challenge')
    const verifyToken = searchParams.get('verify_token')

    const expectedToken =
      process.env.TIKTOK_WEBHOOK_VERIFY_TOKEN || 'tiktok_verify_token'

    if (verifyToken === expectedToken && challenge) {
      console.log('[tiktok/webhook] Webhook verified successfully')
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    console.warn('[tiktok/webhook] Verification failed: token mismatch')
    return NextResponse.json(
      { error: 'Verification failed' },
      { status: 403 },
    )
  } catch (err) {
    console.error('[tiktok/webhook] GET error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}

// ============================================================
// POST — Receive Events
// ============================================================

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as TikTokWebhookPayload

    if (!body.event || !body.business_id || !body.content) {
      return NextResponse.json(
        { error: 'Invalid payload' },
        { status: 400 },
      )
    }

    // Process asynchronously — respond to TikTok immediately
    processEvent(body).catch((err) => {
      console.error('[tiktok/webhook] Async event processing failed:', err)
    })

    return NextResponse.json({ status: 'received' }, { status: 200 })
  } catch (err) {
    console.error('[tiktok/webhook] POST error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}

// ============================================================
// Event Processing
// ============================================================

async function processEvent(payload: TikTokWebhookPayload) {
  const db = supabaseAdmin()
  const { business_id: businessId, event, content } = payload

  // ============ RESOLVE TENANT ============
  const { data: connAcc } = await db
    .from('connected_accounts')
    .select('account_id')
    .eq('provider_account_id', businessId)
    .eq('provider', 'tiktok')
    .maybeSingle()

  if (!connAcc) {
    console.warn(
      `[tiktok/webhook] No connected account for businessId: ${businessId}`,
    )
    return
  }

  const accountId = connAcc.account_id

  // Resolve owner user_id for database FK constraints
  const { data: member } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .in('account_role', ['owner', 'admin'])
    .limit(1)
    .maybeSingle()

  const userId = member?.user_id
  if (!userId) {
    console.warn(
      `[tiktok/webhook] No owner member for accountId: ${accountId}`,
    )
    return
  }

  // ============ ROUTE BY EVENT TYPE ============
  if (event === 'comment.create' || event === 'comment') {
    const c = content as TikTokCommentEvent
    await handleIncoming({
      db,
      accountId,
      userId,
      senderId: c.user_open_id,
      senderName: c.user_display_name || 'TikTok User',
      messageId: c.comment_id,
      text: c.text,
      isComment: true,
      isEcho: false,
      metadata: {
        is_comment: true,
        video_id: c.video_id,
        business_id: businessId,
      },
    })
  } else if (event === 'message.create' || event === 'message') {
    const m = content as TikTokMessageEvent
    // Skip echo (messages sent by the business itself)
    const isEcho = m.sender_open_id === businessId
    await handleIncoming({
      db,
      accountId,
      userId,
      senderId: isEcho ? businessId : m.sender_open_id,
      senderName: isEcho ? 'Business' : (m.sender_display_name || 'TikTok User'),
      messageId: m.message_id,
      text: m.text,
      isComment: false,
      isEcho,
      metadata: {
        is_comment: false,
        business_id: businessId,
      },
    })
  } else {
    console.log(`[tiktok/webhook] Ignoring unhandled event: ${event}`)
  }
}

// ============================================================
// Incoming Content Handler
// ============================================================

interface IncomingParams {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any
  accountId: string
  userId: string
  senderId: string
  senderName: string
  messageId: string
  text: string
  isComment: boolean
  isEcho: boolean
  metadata: Record<string, unknown>
}

async function handleIncoming({
  db,
  accountId,
  userId,
  senderId,
  senderName,
  messageId,
  text,
  isComment,
  isEcho,
  metadata,
}: IncomingParams) {
  // If echo, wait briefly to let CRM/AI insert its own record first
  if (isEcho) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  // ============ 1. RESOLVE OR CREATE CONTACT ============
  const contactPhone = `tiktok:${senderId}`

  let { data: contact } = await db
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .eq('phone', contactPhone)
    .maybeSingle()

  if (!contact) {
    const { data: newContact, error: createError } = await db
      .from('contacts')
      .insert({
        account_id: accountId,
        user_id: userId,
        name: isEcho ? 'TikTok User' : senderName,
        phone: contactPhone,
      })
      .select('id')
      .single()

    if (createError) {
      console.error('[tiktok/webhook] Failed to create contact:', createError)
      return
    }
    contact = newContact
  }

  const contactId = contact.id

  // ============ 2. RESOLVE OR CREATE CONVERSATION ============
  let { data: conversation } = await db
    .from('conversations')
    .select('id, ai_status, ai_agent_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('channel', 'tiktok')
    .maybeSingle()

  if (!conversation) {
    const { data: newConv, error: createConvError } = await db
      .from('conversations')
      .insert({
        account_id: accountId,
        user_id: userId,
        contact_id: contactId,
        channel: 'tiktok',
        status: 'open',
        ai_status: 'active',
      })
      .select('id, ai_status, ai_agent_id')
      .single()

    if (createConvError) {
      console.error(
        '[tiktok/webhook] Failed to create conversation:',
        createConvError,
      )
      return
    }
    conversation = newConv
  }

  const conversationId = conversation.id

  // ============ 3. DEDUPLICATE ============
  const { data: existingMsg } = await db
    .from('messages')
    .select('id')
    .eq('message_id', messageId)
    .maybeSingle()

  if (existingMsg) {
    console.log(
      `[tiktok/webhook] Duplicate message ${messageId} skipped`,
    )
    return
  }

  // ============ 4. INSERT MESSAGE ============
  const { error: msgError } = await db.from('messages').insert({
    conversation_id: conversationId,
    sender_type: isEcho ? 'agent' : 'customer',
    content_type: 'text',
    content_text: text,
    message_id: messageId,
    status: 'sent',
    channel: 'tiktok',
    metadata,
  })

  if (msgError) {
    console.error('[tiktok/webhook] Failed to insert message:', msgError)
    return
  }

  // ============ 5. UPDATE CONVERSATION ============
  await db
    .from('conversations')
    .update({
      last_message_text: text,
      last_message_at: new Date().toISOString(),
      unread_count: isEcho ? 0 : 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)

  // ============ 6. ECHO → PAUSE AI ============
  if (isEcho) {
    if (conversation.ai_status !== 'disabled') {
      try {
        await pauseAI(conversationId, conversation.ai_agent_id || undefined)
        console.log(
          '[tiktok/webhook] AI paused — business owner replied manually',
        )
      } catch (err) {
        console.error('[tiktok/webhook] Failed to pause AI:', err)
      }
    }
    return
  }

  // ============ 7. DISPATCH TO AI AGENT ============
  await dispatchToAIAgent({
    accountId,
    conversationId,
    contactId,
    messageText: text,
    userId,
    accessToken: '',
    channel: 'tiktok',
  })
}
