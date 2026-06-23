import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const db = supabaseAdmin()

    // 1. Fetch aggregate metrics from logs
    const { data: metricsData, error: metricsError } = await db
      .from('ai_conversation_logs')
      .select('conversation_id, prompt_tokens, completion_tokens, total_cost_usd, latency_ms')
      .eq('agent_id', id)

    if (metricsError) {
      throw metricsError
    }

    // 2. Fetch appointments booked by this agent
    const { count: appointmentsCount, error: apptError } = await db
      .from('ai_appointments')
      .select('*', { count: 'exact', head: true })
      .eq('agent_id', id)
      .neq('status', 'cancelled')

    if (apptError) {
      throw apptError
    }

    // Process aggregates
    let totalMessages = 0
    let totalTokens = 0
    let totalCost = 0
    const uniqueConversations = new Set<string>()

    if (metricsData) {
      totalMessages = metricsData.length
      for (const row of metricsData) {
        totalTokens += (row.prompt_tokens || 0) + (row.completion_tokens || 0)
        totalCost += parseFloat(row.total_cost_usd) || 0
        if (row.conversation_id) {
          uniqueConversations.add(row.conversation_id)
        }
      }
    }

    // 3. Fetch recent logs (last 50)
    const { data: recentLogs, error: logsError } = await db
      .from('ai_conversation_logs')
      .select('id, created_at, model_used, prompt_tokens, completion_tokens, latency_ms, total_cost_usd')
      .eq('agent_id', id)
      .order('created_at', { ascending: false })
      .limit(50)

    if (logsError) {
      throw logsError
    }

    return NextResponse.json({
      metrics: {
        totalMessages,
        totalTokens,
        totalCost,
        peopleReached: uniqueConversations.size,
        appointmentsBooked: appointmentsCount || 0,
        // Assume 2 minutes saved per message sent
        timeSavedMinutes: totalMessages * 2,
      },
      recentLogs: recentLogs || [],
    })
  } catch (err) {
    console.error('[api/ai/agents/[id]/analytics] GET error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
