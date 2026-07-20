import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { executeAgent } from '@/lib/ai/agent-engine'
import type { AIAgent } from '@/lib/ai/types'

// Prevent Next.js from caching this API route
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  // Vercel Cron sends a Bearer token with CRON_SECRET
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // 1. Fetch pending follow-ups that are due
  const { data: followUps, error } = await supabase
    .from('follow_ups')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', new Date().toISOString())
    .limit(50) // Batch process to avoid hitting timeout limits

  if (error || !followUps) {
    console.error('[cron/follow-ups] Error fetching follow-ups:', error)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }

  if (followUps.length === 0) {
    return NextResponse.json({ ok: true, processed: 0 })
  }

  console.log(`[cron/follow-ups] Processing ${followUps.length} due follow-ups...`)

  let processedCount = 0

  // Process sequentially to be safe with DB connections and limits
  for (const followup of followUps) {
    try {
      // 2. Fetch the assigned AI agent config
      const { data: agentData } = await supabase
        .from('ai_agents')
        .select('*')
        .eq('id', followup.agent_id)
        .single()

      if (!agentData || !agentData.is_active) {
        // Agent no longer exists or is inactive, mark follow-up as cancelled
        await supabase
          .from('follow_ups')
          .update({ status: 'cancelled', error_message: 'Agent inactive or deleted' })
          .eq('id', followup.id)
        continue
      }

      // 3. Fetch the owner user_id to send the message
      const { data: config } = await supabase
        .from('whatsapp_config')
        .select('user_id')
        .eq('account_id', followup.account_id)
        .maybeSingle()

      // 4. Wake up the LLM and send the follow-up
      const reply = await executeAgent(agentData as AIAgent, {
        accountId: followup.account_id,
        conversationId: followup.conversation_id,
        contactId: followup.contact_id,
        messageText: '', // No user message, this is proactive!
        userId: config?.user_id || '',
        accessToken: '', // The executeAgent handles resolving decrypted tokens if omitted/blank
        channel: 'whatsapp',
        proactiveInstruction: followup.task_description,
      })

      if (reply) {
        // 5. Only mark as completed if the message was successfully dispatched
        await supabase
          .from('follow_ups')
          .update({ status: 'completed', completed_at: new Date().toISOString() })
          .eq('id', followup.id)
        processedCount++
      } else {
        // Mark as failed if the agent engine returned null (e.g. gateway fetch failed or env var missing)
        await supabase
          .from('follow_ups')
          .update({ 
            status: 'failed', 
            error_message: 'Agent returned null (dispatch failed, gateway offline, or WHATSAPP_GATEWAY_URL not configured on Vercel)' 
          })
          .eq('id', followup.id)
      }
    } catch (err) {
      console.error(`[cron/follow-ups] Failed to process follow_up ${followup.id}:`, err)
      await supabase
        .from('follow_ups')
        .update({ status: 'failed', error_message: String(err) })
        .eq('id', followup.id)
    }
  }

  console.log(`[cron/follow-ups] Successfully processed ${processedCount} follow-ups.`)
  return NextResponse.json({ ok: true, processed: processedCount })
}
