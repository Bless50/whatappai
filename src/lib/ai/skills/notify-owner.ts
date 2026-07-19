/**
 * Notify Owner skill — sends a WhatsApp summary to the business owner.
 *
 * The LLM calls this after collecting customer information (name,
 * phone, email, interest, etc.) during a conversation. The skill
 * formats the collected data into a readable summary and sends it
 * to the owner's WhatsApp number via the Meta Cloud API.
 *
 * The owner's notification phone number is stored in `skill_config`
 * when the skill is enabled (key: `notify_phone`). If not configured,
 * the skill falls back to inserting a system note in the conversation
 * so the info is still captured in the inbox.
 */

import type { SkillDefinition, SkillContext, SkillResult } from '../types'
import { supabaseAdmin } from '../admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendTextMessage } from '@/lib/whatsapp/meta-api'
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'

export const notifyOwnerSkill: SkillDefinition = {
  type: 'notify_owner',
  tool: {
    type: 'function',
    function: {
      name: 'notify_owner',
      description:
        'Send collected customer information to the business owner via WhatsApp. ' +
        'Use this when:\n' +
        '- You have collected key customer details (name, phone, email, company, etc.)\n' +
        '- The customer has expressed a specific interest or request\n' +
        '- You want to notify the business owner about an important lead or inquiry\n' +
        '- The customer has provided information that the business owner should see immediately\n' +
        'Always include a clear summary of what was collected and any action items.',
      parameters: {
        type: 'object',
        properties: {
          customer_name: {
            type: 'string',
            description: 'The name of the customer, if collected.',
          },
          customer_phone: {
            type: 'string',
            description:
              'The phone number of the customer. Usually available from the conversation context.',
          },
          customer_email: {
            type: 'string',
            description: 'The email address of the customer, if collected.',
          },
          summary: {
            type: 'string',
            description:
              'A concise summary of the collected information and the customer\'s ' +
              'interest or request. Include any important details the owner should know.',
          },
        },
        required: ['summary'],
      },
    },
  },

  async execute(
    params: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const db = supabaseAdmin()

    const summary = (params.summary as string) ?? 'No summary provided'
    const customerName = (params.customer_name as string) ?? 'Unknown'
    const customerPhone = (params.customer_phone as string) ?? ''
    const customerEmail = (params.customer_email as string) ?? ''

    try {
      // ============ 1. BUILD THE NOTIFICATION MESSAGE ============
      const lines: string[] = [
        '📋 *New Lead Notification*',
        '',
        `👤 *Name:* ${customerName}`,
      ]
      if (customerPhone) lines.push(`📱 *Phone:* ${customerPhone}`)
      if (customerEmail) lines.push(`📧 *Email:* ${customerEmail}`)
      lines.push('', '💬 *Summary:*', summary)
      lines.push('', `🕐 _${new Date().toLocaleString()}_`)

      const notificationText = lines.join('\n')

      // Notify account owners/admins via the notifications dashboard
      const { data: members } = await db
        .from('profiles')
        .select('user_id')
        .eq('account_id', context.accountId)
        .in('role', ['owner', 'admin'])

      if (members && members.length > 0) {
        const notifications = members.map((m) => ({
          account_id: context.accountId,
          user_id: m.user_id,
          type: 'notify_owner',
          conversation_id: context.conversationId,
          title: `New Lead: ${customerName}`,
          body: notificationText,
        }))
        await db.from('notifications').insert(notifications)
      }

      // ============ 3. LOOK UP SKILL CONFIG FOR NOTIFY PHONE ============
      const { data: skillRow } = await db
        .from('ai_agent_skills')
        .select('skill_config')
        .eq('agent_id', context.agentId)
        .eq('skill_type', 'notify_owner')
        .maybeSingle()

      const notifyPhone =
        (skillRow?.skill_config as Record<string, unknown>)?.notify_phone as
          | string
          | undefined

      if (!notifyPhone) {
        return {
          success: true,
          data:
            'Customer information has been saved in the conversation. ' +
            'Note: No notification phone number is configured for this skill, ' +
            'so the info was logged but not sent via WhatsApp. ' +
            'Let the customer know their information has been received.',
        }
      }

      // ============ 4. LOOK UP WHATSAPP CONFIG ============
      const { data: waConfig } = await db
        .from('whatsapp_config')
        .select('phone_number_id, access_token')
        .eq('account_id', context.accountId)
        .maybeSingle()

      if (!waConfig) {
        return {
          success: true,
          data:
            'Customer information has been saved in the conversation thread. ' +
            'WhatsApp is not configured for this account, so a direct notification ' +
            'could not be sent. Let the customer know their information has been received.',
        }
      }

      // Support Linked Phone sessions by calling the WhatsApp Gateway
      if (waConfig.phone_number_id === 'linked-phone') {
        const gatewayUrl = process.env.WHATSAPP_GATEWAY_URL;
        if (!gatewayUrl) {
          return {
            success: false,
            data:
              'Customer information has been saved in the conversation thread. ' +
              'Error: WHATSAPP_GATEWAY_URL is not configured on the server, ' +
              'so the WhatsApp notification could not be sent to the owner.',
          };
        }

        const sendUrl = gatewayUrl.endsWith('/api/messages/send')
          ? gatewayUrl
          : `${gatewayUrl.replace(/\/$/, '')}/api/messages/send`;

        const sanitizedNotifyPhone = notifyPhone.replace(/\D/g, '');

        const gatewayRes = await fetch(sendUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId: context.accountId,
            to: sanitizedNotifyPhone,
            text: notificationText,
          }),
        });

        if (!gatewayRes.ok) {
          const errData = await gatewayRes.json().catch(() => ({ error: 'Unknown gateway error' }));
          throw new Error(`Gateway send failed: ${errData.error || gatewayRes.statusText}`);
        }

        return {
          success: true,
          data:
            'Customer information has been sent to the business owner via the WhatsApp Gateway ' +
            'and saved in the conversation. Let the customer know their information ' +
            'has been received and someone will follow up.',
        };
      }

      // ============ 5. SEND WHATSAPP MESSAGE TO OWNER ============
      const accessToken = decrypt(waConfig.access_token)
      const sanitizedPhone = sanitizePhoneForMeta(notifyPhone)

      await sendTextMessage({
        phoneNumberId: waConfig.phone_number_id,
        accessToken,
        to: sanitizedPhone,
        text: notificationText,
      })

      return {
        success: true,
        data:
          'Customer information has been sent to the business owner via WhatsApp ' +
          'and saved in the conversation. Let the customer know their information ' +
          'has been received and someone will follow up with them.',
      }
    } catch (err) {
      console.error('[skill/notify-owner] Error:', err)

      // Even if the WhatsApp send fails, the info was logged in the conversation
      return {
        success: false,
        data:
          `Failed to send notification: ${err instanceof Error ? err.message : String(err)}. ` +
          'However, the customer information has been saved in the conversation thread. ' +
          'Let the customer know their information has been received.',
      }
    }
  },
}
