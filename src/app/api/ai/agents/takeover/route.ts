/**
 * AI Takeover API — Pause and Resume AI on conversations.
 *
 * POST /api/ai/agents/takeover
 *   body: { conversation_id, action: 'pause' | 'resume' }
 *
 * Called by the inbox UI when a human agent clicks "Take Over"
 * or "Hand Back to AI".
 */

import { NextResponse } from 'next/server'
import { pauseAI, resumeAI } from '@/lib/ai/agent-dispatcher'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { conversation_id, action, agent_id } = body

    if (!conversation_id || !action) {
      return NextResponse.json(
        { error: 'conversation_id and action are required' },
        { status: 400 },
      )
    }

    if (action === 'pause') {
      await pauseAI(conversation_id, agent_id)
      return NextResponse.json({ success: true, status: 'paused' })
    }

    if (action === 'resume') {
      await resumeAI(conversation_id)
      return NextResponse.json({ success: true, status: 'active' })
    }

    return NextResponse.json(
      { error: 'action must be "pause" or "resume"' },
      { status: 400 },
    )
  } catch (err) {
    console.error('[api/ai/agents/takeover] error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
