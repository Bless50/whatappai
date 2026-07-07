import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { dispatchToAIAgent, pauseAI } from '@/lib/ai/agent-dispatcher'

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

// GET - Webhook Verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const token = searchParams.get('hub.verify_token')
    const challenge = searchParams.get('hub.challenge')

    const verifyToken = process.env.FB_WEBHOOK_VERIFY_TOKEN || 'meta_verify_token'

    if (mode === 'subscribe' && token === verifyToken) {
      console.log('[facebook/webhook] Webhook verified successfully')
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    console.warn('[facebook/webhook] Verification failed: token mismatch')
    return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
  } catch (err) {
    console.error('[facebook/webhook] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST - Receive messages & comments
export async function POST(request: Request) {
  try {
    const rawBody = await request.text()
    const signature = request.headers.get('x-hub-signature-256')

    if (signature && !verifyMetaWebhookSignature(rawBody, signature)) {
      console.warn('[facebook/webhook] Rejected request with invalid signature')
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    let body: any
    try {
      body = JSON.parse(rawBody)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    if (body.object !== 'page' && body.object !== 'instagram') {
      return NextResponse.json({ status: 'ignored_object_type' }, { status: 200 })
    }

    processEvents(body).catch((err) => {
      console.error('[facebook/webhook] Async event processing failed:', err)
    })

    return NextResponse.json({ status: 'received' }, { status: 200 })
  } catch (err) {
    console.error('[facebook/webhook] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

async function processEvents(body: any) {
  const db = supabaseAdmin()

  for (const entry of body.entry || []) {
    const pageId = entry.id // Meta Page or Instagram business account ID
    const channel = body.object === 'instagram' ? 'instagram' : 'facebook'
    
    // 1. Resolve tenant account_id from connected_accounts
    const { data: connAcc } = await db
      .from('connected_accounts')
      .select('account_id')
      .eq('provider_account_id', pageId)
      .eq('provider', channel)
      .maybeSingle()

    if (!connAcc) {
      console.warn(`[facebook/webhook] No connected account found for pageId: ${pageId} on channel: ${channel}`)
      continue
    }

    const accountId = connAcc.account_id

    // Resolve owner user_id to satisfy database FK constraints
    const { data: member } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId)
      .in('account_role', ['owner', 'admin'])
      .limit(1)
      .maybeSingle()

    const userId = member?.user_id
    if (!userId) {
      console.warn(`[facebook/webhook] No owner member found for accountId: ${accountId}`)
      continue
    }

    // Handle comments or feed updates
    if (entry.changes) {
      for (const change of entry.changes) {
        if (change.field !== 'feed' && change.field !== 'comments') continue

        const val = change.value
        if (!val || val.item !== 'comment' || val.verb !== 'add') continue

        const senderId = val.from?.id
        const senderName = val.from?.name || 'Social User'
        const commentText = val.message
        const commentId = val.comment_id
        const postId = val.post_id
        const parentId = val.parent_id // Could be post or comment

        // Check if echo (written by the page itself)
        const isEcho = senderId === pageId

        await handleIncomingContent({
          db,
          channel,
          accountId,
          userId,
          senderId: isEcho ? pageId : senderId,
          senderName: isEcho ? 'Business Owner' : senderName,
          messageId: commentId,
          text: commentText,
          isComment: true,
          isEcho,
          metadata: {
            is_comment: true,
            post_id: postId,
            parent_id: parentId,
            page_id: pageId,
          }
        })
      }
    }

    // Handle messages (DMs)
    if (entry.messaging) {
      for (const msgEvent of entry.messaging) {
        const senderId = msgEvent.sender?.id
        const recipientId = msgEvent.recipient?.id
        
        const message = msgEvent.message
        if (!message || !message.text) continue

        const text = message.text
        const messageId = message.mid

        // Check if echo (sender is pageId)
        const isEcho = senderId === pageId
        const targetCustomerId = isEcho ? recipientId : senderId

        if (!targetCustomerId) continue

        await handleIncomingContent({
          db,
          channel,
          accountId,
          userId,
          senderId: targetCustomerId,
          senderName: 'Social User',
          messageId,
          text,
          isComment: false,
          isEcho,
          metadata: {
            is_comment: false,
            page_id: pageId,
          }
        })
      }
    }
  }
}

interface IncomingContentParams {
  db: any
  channel: 'facebook' | 'instagram'
  accountId: string
  userId: string
  senderId: string
  senderName: string
  messageId: string
  text: string
  isComment: boolean
  isEcho: boolean
  metadata: Record<string, any>
}

async function handleIncomingContent({
  db,
  channel,
  accountId,
  userId,
  senderId,
  senderName,
  messageId,
  text,
  isComment,
  isEcho,
  metadata
}: IncomingContentParams) {
  // If it is an echo (outbound manual message), wait 2 seconds to let the CRM or AI insert it first
  if (isEcho) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  // 1. Resolve or create contact using prefixed JID format
  const contactPhone = `${channel}:${senderId}`
  
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
        name: isEcho ? 'Social User' : senderName,
        phone: contactPhone,
      })
      .select('id')
      .single()

    if (createError) {
      console.error('[facebook/webhook] Failed to create contact:', createError)
      return
    }
    contact = newContact
  }

  const contactId = contact.id

  // 2. Resolve or create conversation
  let { data: conversation } = await db
    .from('conversations')
    .select('id, ai_status, ai_agent_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('channel', channel)
    .maybeSingle()

  if (!conversation) {
    const { data: newConv, error: createConvError } = await db
      .from('conversations')
      .insert({
        account_id: accountId,
        user_id: userId,
        contact_id: contactId,
        channel,
        status: 'open',
        ai_status: 'active',
      })
      .select('id, ai_status, ai_agent_id')
      .single()

    if (createConvError) {
      console.error('[facebook/webhook] Failed to create conversation:', createConvError)
      return
    }
    conversation = newConv
  }

  const conversationId = conversation.id

  const prefixedMsgId = isComment ? `comment:${messageId}` : `dm:${messageId}`

  // Check if message already exists (handled by CRM or AI)
  const { data: existingMsg } = await db
    .from('messages')
    .select('id')
    .eq('message_id', prefixedMsgId)
    .maybeSingle()

  if (existingMsg) {
    console.log(`[facebook/webhook] Duplicate message ${prefixedMsgId} skipped (handled by CRM/AI)`)
    return
  }

  // 3. Insert message
  const { error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: isEcho ? 'agent' : 'customer',
      content_type: 'text',
      content_text: text,
      message_id: prefixedMsgId,
      status: 'sent',
      channel,
    })

  if (msgError) {
    console.error('[facebook/webhook] Failed to insert message:', msgError)
    return
  }

  // 4. Update conversation states
  await db
    .from('conversations')
    .update({
      last_message_text: text,
      last_message_at: new Date().toISOString(),
      unread_count: isEcho ? 0 : 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)

  // 5. If it is an echo (outbound manual message), PAUSE the AI
  if (isEcho) {
    if (conversation.ai_status !== 'disabled') {
      try {
        await pauseAI(conversationId, conversation.ai_agent_id || undefined)
        console.log(`[facebook/webhook] AI agent paused because owner sent message/reply on Facebook/Instagram`)
      } catch (err) {
        console.error('[facebook/webhook] Failed to pause AI:', err)
      }
    }
    return
  }

  // 6. Dispatch to AI Agent if not paused
  await dispatchToAIAgent({
    accountId,
    conversationId,
    contactId,
    messageText: text,
    userId,
    accessToken: '',
    channel,
  })
}
