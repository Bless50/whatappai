import type { SkillDefinition, SkillContext, SkillResult } from '../types'
import { supabaseAdmin } from '../admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendMediaMessage } from '@/lib/whatsapp/meta-api'
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'

export const sendProductSkill: SkillDefinition = {
  type: 'send_product',
  tool: {
    type: 'function',
    function: {
      name: 'send_product',
      description:
        'Search for a specific product (like a dress, shoes, accessories) in the database and immediately send its photo and pricing to the customer via WhatsApp. ' +
        'CRITICAL: If the customer asks "what do you have" or "show me your dresses", DO NOT use this tool first. Use search_products first to get a list of available items, tell the customer what you have, and THEN use this tool when they pick one.',
      parameters: {
        type: 'object',
        properties: {
          search_query: {
            type: 'string',
            description: 'Keywords to search for the product in the inventory (e.g. "dress", "spaghetti strap").',
          },
          caption: {
            type: 'string',
            description: 'Optional message to send with the image (e.g. "Here is the Spaghetti Strap Flowy Dress. It is in stock for 10,500F.").',
          },
        },
        required: ['search_query'],
      },
    },
  },

  async execute(
    params: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const db = supabaseAdmin()
    const searchQuery = (params.search_query as string) ?? ''
    const customCaption = params.caption as string | undefined

    try {
      // 1. SEARCH FOR PRODUCT IN DATABASE
      const { data: nameMatchProducts, error: searchErr } = await db
        .from('products')
        .select('*')
        .eq('account_id', context.accountId)
        .ilike('name', `%${searchQuery}%`)
        .limit(1)

      let products = nameMatchProducts || []

      if (searchErr || products.length === 0) {
        // Fall back to searching description if name query found nothing
        const { data: fallbackProducts, error: fallbackErr } = await db
          .from('products')
          .select('*')
          .eq('account_id', context.accountId)
          .ilike('description', `%${searchQuery}%`)
          .limit(1)

        if (fallbackErr || !fallbackProducts || fallbackProducts.length === 0) {
          return {
            success: false,
            data: `No product found in stock matching query: "${searchQuery}". Please ask the customer for clarification or suggest checking other items.`,
          }
        }
        products = fallbackProducts
      }

      const product = products[0]

      if (!product.image_url) {
        return {
          success: false,
          data: `Product "${product.name}" was found, but it has no product image URL configured in the system. Pricing is ${product.price}.`,
        }
      }

      // 2. FETCH THE WHATSAPP CONFIG
      const { data: waConfig } = await db
        .from('whatsapp_config')
        .select('phone_number_id, access_token')
        .eq('account_id', context.accountId)
        .maybeSingle()

      if (!waConfig) {
        return {
          success: false,
          data: `Product "${product.name}" was found, but WhatsApp is not configured for this account yet.`,
        }
      }

      // 3. FETCH THE CUSTOMER'S PHONE NUMBER
      const { data: contact } = await db
        .from('contacts')
        .select('phone')
        .eq('id', context.contactId)
        .single()

      if (!contact?.phone) {
        throw new Error('Customer phone number not found')
      }

      const sanitizedPhone = contact.phone.replace(/\D/g, '')
      const displayCaption = customCaption || `Here is the ${product.name} (Price: ${product.price}).`

      let messageId = ''

      // 4. SEND MEDIA MESSAGE VIA WHATSAPP (Gateway or Meta Cloud API)
      if (waConfig.phone_number_id === 'linked-phone') {
        const gatewayUrl = process.env.WHATSAPP_GATEWAY_URL
        if (!gatewayUrl) {
          throw new Error('WHATSAPP_GATEWAY_URL environment variable is not defined')
        }

        const sendUrl = gatewayUrl.endsWith('/api/messages/send')
          ? gatewayUrl
          : `${gatewayUrl.replace(/\/$/, '')}/api/messages/send`

        // Generate synthetic messageId first, similar to other gateway sends
        messageId = `3EB0${crypto.randomUUID().replace(/-/g, '').substring(0, 18).toUpperCase()}`

        const gatewayRes = await fetch(sendUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId: context.accountId,
            to: sanitizedPhone,
            text: displayCaption,
            mediaUrl: product.image_url,
            mediaType: 'image',
          }),
        })

        if (!gatewayRes.ok) {
          const errData = await gatewayRes.json().catch(() => ({ error: 'Unknown gateway error' }))
          throw new Error(`Gateway send failed: ${errData.error}`)
        }

        const resData = await gatewayRes.json().catch(() => null)
        if (resData?.success && resData.messageId) {
          messageId = resData.messageId
        }
      } else {
        const waAccessToken = decrypt(waConfig.access_token)
        const metaPhone = sanitizePhoneForMeta(contact.phone)

        const sendResult = await sendMediaMessage({
          phoneNumberId: waConfig.phone_number_id,
          accessToken: waAccessToken,
          to: metaPhone,
          kind: 'image',
          link: product.image_url,
          caption: displayCaption,
        })
        messageId = sendResult?.messageId ?? ''
      }

      // 5. INSERT BOT MESSAGE INTO THE CRM MESSAGES TABLE
      if (messageId) {
        await db.from('messages').insert({
          conversation_id: context.conversationId,
          sender_type: 'bot',
          content_type: 'image',
          content_text: displayCaption,
          media_url: product.image_url,
          message_id: messageId,
          status: 'sent',
        })

        // 6. UPDATE CONVERSATION FOR INBOX PREVIEW
        await db
          .from('conversations')
          .update({
            last_message_text: `📷 [Image] ${product.name}`,
            last_message_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', context.conversationId)
      }

      return {
        success: true,
        data: `Product "${product.name}" image successfully sent to the customer via WhatsApp.`,
      }
    } catch (err) {
      console.error('[skill/send-product] Error:', err)
      return {
        success: false,
        data: `Failed to retrieve and send product: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
}
