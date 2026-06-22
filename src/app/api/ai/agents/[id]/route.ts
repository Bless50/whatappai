/**
 * AI Agent API — Get, Update, Delete a single agent.
 *
 * GET    /api/ai/agents/[id] → get agent details
 * PATCH  /api/ai/agents/[id] → update agent config
 * DELETE /api/ai/agents/[id] → delete agent
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

interface RouteContext {
  params: Promise<{ id: string }>
}

// ============================================================
// GET — Get a single agent with its skills
// ============================================================

export async function GET(
  _request: Request,
  context: RouteContext,
) {
  try {
    const { id } = await context.params

    const { data: agent, error } = await supabaseAdmin()
      .from('ai_agents')
      .select(
        '*, ai_agent_skills(*), ai_agent_knowledge_bases(knowledge_base_id, ai_knowledge_bases(id, name))',
      )
      .eq('id', id)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Strip the encrypted API key from the response — frontend
    // should never see it. Send a boolean flag instead.
    const hasApiKey = !!(agent.openrouter_key || agent.openrouter_api_key)
    const { openrouter_key: _ok, openrouter_api_key: _oak, ...safeAgent } = agent

    return NextResponse.json({ agent: { ...safeAgent, has_api_key: hasApiKey } })
  } catch (err) {
    console.error('[api/ai/agents/[id]] GET error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}

// ============================================================
// PATCH — Update agent configuration
// ============================================================

export async function PATCH(
  request: Request,
  context: RouteContext,
) {
  try {
    const { id } = await context.params
    const body = await request.json()

    // Build update object from allowed fields only
    const allowedFields = [
      'name', 'description', 'avatar_url', 'is_active', 'system_prompt',
      'model_name', 'temperature', 'max_tokens', 'channels',
      'takeover_mode', 'takeover_timeout_minutes',
    ]

    const updates: Record<string, unknown> = {}
    for (const field of allowedFields) {
      if (field in body) {
        updates[field] = body[field]
      }
    }

    // Handle API key separately — encrypt it
    if ('openrouter_api_key' in body && body.openrouter_api_key) {
      updates.openrouter_key = encrypt(body.openrouter_api_key)
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: 'No valid fields to update' },
        { status: 400 },
      )
    }

    const { data: agent, error } = await supabaseAdmin()
      .from('ai_agents')
      .update(updates)
      .eq('id', id)
      .select(
        'id, account_id, name, description, is_active, system_prompt, ' +
        'model_name, temperature, max_tokens, channels, takeover_mode, ' +
        'takeover_timeout_minutes, updated_at',
      )
      .single()

    // Handle Knowledge Base assignments
    if ('knowledge_base_ids' in body && Array.isArray(body.knowledge_base_ids)) {
      const db = supabaseAdmin()
      await db.from('ai_agent_knowledge_bases').delete().eq('agent_id', id)
      
      if (body.knowledge_base_ids.length > 0) {
        const kbInserts = body.knowledge_base_ids.map((kbId: string) => ({
          agent_id: id,
          knowledge_base_id: kbId
        }))
        await db.from('ai_agent_knowledge_bases').insert(kbInserts)
      }
    }

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ agent })
  } catch (err) {
    console.error('[api/ai/agents/[id]] PATCH error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}

// ============================================================
// DELETE — Delete an agent
// ============================================================

export async function DELETE(
  _request: Request,
  context: RouteContext,
) {
  try {
    const { id } = await context.params

    const { error } = await supabaseAdmin()
      .from('ai_agents')
      .delete()
      .eq('id', id)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[api/ai/agents/[id]] DELETE error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
