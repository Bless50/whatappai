/**
 * AI Agents API — List and Create.
 *
 * GET  /api/ai/agents → list all agents for the caller's account
 * POST /api/ai/agents → create a new agent
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { encrypt } from '@/lib/whatsapp/encryption'

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
// GET — List agents for the caller's account
// ============================================================

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const accountId = searchParams.get('account_id')

    if (!accountId) {
      return NextResponse.json(
        { error: 'account_id is required' },
        { status: 400 },
      )
    }

    const { data: agents, error } = await supabaseAdmin()
      .from('ai_agents')
      .select(
        'id, account_id, name, description, avatar_url, is_active, ' +
        'system_prompt, prompt_personality, prompt_goal, prompt_general_info, model_name, temperature, max_tokens, channels, ' +
        'takeover_mode, takeover_timeout_minutes, provider, ' +
        'booking_link, created_at, updated_at',
      )
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('[api/ai/agents] list error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ agents: agents ?? [] })
  } catch (err) {
    console.error('[api/ai/agents] GET error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}

// ============================================================
// POST — Create a new agent
// ============================================================

export async function POST(request: Request) {
  try {
    const body = await request.json()

    const {
      account_id,
      name,
      description,
      system_prompt,
      model_name,
      temperature,
      max_tokens,
      openrouter_api_key,
      channels,
      takeover_mode,
      takeover_timeout_minutes,
      prompt_personality,
      prompt_goal,
      prompt_general_info,
    } = body

    if (!account_id || !name) {
      return NextResponse.json(
        { error: 'account_id and name are required' },
        { status: 400 },
      )
    }

    // Encrypt the API key if provided
    const encryptedKey = openrouter_api_key
      ? encrypt(openrouter_api_key)
      : null

    const insertData: Record<string, unknown> = {
      account_id,
      name,
      description: description ?? null,
      system_prompt: system_prompt ?? 'You are a helpful AI assistant for this business. Be friendly, professional, and concise.',
      prompt_personality: prompt_personality ?? null,
      prompt_goal: prompt_goal ?? null,
      prompt_general_info: prompt_general_info ?? null,
      model_name: model_name ?? 'google/gemini-2.5-flash',
      temperature: temperature ?? 0.7,
      max_tokens: max_tokens ?? 1024,
      openrouter_key: encryptedKey,
      channels: channels ?? ['whatsapp'],
      takeover_mode: takeover_mode ?? 'timeout',
      takeover_timeout_minutes: takeover_timeout_minutes ?? 120,
      is_active: false, // New agents start inactive — user toggles on
    }

    const { data: agent, error } = await supabaseAdmin()
      .from('ai_agents')
      .insert(insertData)
      .select(
        'id, account_id, name, description, is_active, system_prompt, ' +
        'prompt_personality, prompt_goal, prompt_general_info, ' +
        'model_name, temperature, max_tokens, channels, takeover_mode, ' +
        'takeover_timeout_minutes, created_at',
      )
      .single()

    if (error) {
      console.error('[api/ai/agents] create error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ agent }, { status: 201 })
  } catch (err) {
    console.error('[api/ai/agents] POST error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
