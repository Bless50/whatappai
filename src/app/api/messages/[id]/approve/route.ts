import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendTextMessage } from '@/lib/whatsapp/meta-api'

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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: messageUuid } = await params
    const body = await request.json().catch(() => ({}))
    const { editedText } = body

    const db = supabaseAdmin()

    // 1. Fetch message and conversation
    const { data: message, error: msgError } = await db
      .from('messages')
      .select('*, conversations(account_id, contact_id, channel)')
      .eq('id', messageUuid)
      .single()

    if (msgError || !message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    if (message.status !== 'pending_approval') {
      return NextResponse.json({ error: 'Message is not pending approval' }, { status: 400 })
    }

    const replyText = editedText || message.content_text
    const conversation = message.conversations
    const accountId = conversation.account_id
    const channel = message.channel || conversation.channel

    let finalMessageId = message.message_id

    // Fetch contact phone/JID
    const { data: contact } = await db
      .from('contacts')
      .select('phone')
      .eq('id', conversation.contact_id)
      .single()

    const contactPhone = contact?.phone ?? ''

    // 2. Dispatch based on channel
    if (channel === 'facebook' || channel === 'instagram') {
      const { data: connAcc } = await db
        .from('connected_accounts')
        .select('access_token')
        .eq('account_id', accountId)
        .eq('provider', channel)
        .maybeSingle()

      if (!connAcc || !connAcc.access_token) {
        return NextResponse.json({ error: `No Meta token found for channel ${channel}` }, { status: 400 })
      }

      let token = connAcc.access_token
      try {
        token = decrypt(connAcc.access_token)
      } catch {
        // Plain text
      }

      const isComment = message.metadata?.is_comment === true
      const parentId = message.metadata?.parent_id

      if (isComment && parentId) {
        // Comment reply
        const url = `https://graph.facebook.com/v19.0/${parentId}/comments?access_token=${token}`
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: replyText })
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          return NextResponse.json({ error: err.error?.message || 'Meta Comment send failed' }, { status: 500 })
        }
        const resData = await res.json()
        finalMessageId = resData.id || finalMessageId
      } else {
        // DM
        const recipientId = contactPhone.split(':').pop() || contactPhone // extract actual sender ID (strip channel: prefix if present)
        const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${token}`
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: { id: recipientId },
            message: { text: replyText }
          })
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          return NextResponse.json({ error: err.error?.message || 'Meta Message send failed' }, { status: 500 })
        }
        const resData = await res.json()
        finalMessageId = resData.message_id || finalMessageId
      }
    } else {
      // WhatsApp
      const { data: waConfig } = await db
        .from('whatsapp_config')
        .select('phone_number_id, access_token')
        .eq('account_id', accountId)
        .maybeSingle()

      if (!waConfig) {
        return NextResponse.json({ error: 'WhatsApp config not found' }, { status: 400 })
      }

      const sanitizedPhone = contactPhone.replace(/\D/g, '')

      if (waConfig.phone_number_id === 'linked-phone') {
        const gatewayUrl = process.env.WHATSAPP_GATEWAY_URL
        if (!gatewayUrl) {
          return NextResponse.json({ error: 'WhatsApp gateway URL not configured' }, { status: 500 })
        }
        const sendUrl = gatewayUrl.endsWith('/api/messages/send')
          ? gatewayUrl
          : `${gatewayUrl.replace(/\/$/, '')}/api/messages/send`

        const gatewayRes = await fetch(sendUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId,
            to: sanitizedPhone,
            text: replyText,
          }),
        }).catch(() => null)

        if (!gatewayRes || !gatewayRes.ok) {
          return NextResponse.json({ error: 'Failed to send via WhatsApp gateway' }, { status: 500 })
        }

        const resData = await gatewayRes.json().catch(() => null)
        if (resData?.success && resData.messageId) {
          finalMessageId = resData.messageId
        }
      } else {
        const waAccessToken = decrypt(waConfig.access_token)
        const sendResult = await sendTextMessage({
          phoneNumberId: waConfig.phone_number_id,
          accessToken: waAccessToken,
          to: sanitizedPhone,
          text: replyText,
        })
        if (sendResult?.messageId) {
          finalMessageId = sendResult.messageId
        }
      }
    }

    // 3. Update the message record
    const { error: updateError } = await db
      .from('messages')
      .update({
        content_text: replyText,
        message_id: finalMessageId,
        status: 'sent',
      })
      .eq('id', messageUuid)

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    // 4. Update the conversation details
    await db
      .from('conversations')
      .update({
        last_message_text: replyText,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', message.conversation_id)

    return NextResponse.json({ success: true, messageId: finalMessageId })
  } catch (err) {
    console.error('[messages/approve] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
