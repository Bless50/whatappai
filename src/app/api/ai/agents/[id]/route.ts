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
    const safeAgent = { approval_mode: false, ...agent }
    delete safeAgent.openrouter_key
    delete safeAgent.openrouter_api_key

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
      'prompt_personality', 'prompt_goal', 'prompt_general_info',
      'model_name', 'temperature', 'max_tokens', 'channels',
      'takeover_mode', 'takeover_timeout_minutes', 'approval_mode',
      'response_delay_seconds',
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

    let updateResult = await supabaseAdmin()
      .from('ai_agents')
      .update(updates)
      .eq('id', id)
      .select(
        'id, account_id, name, description, is_active, system_prompt, ' +
        'prompt_personality, prompt_goal, prompt_general_info, ' +
        'model_name, temperature, max_tokens, channels, takeover_mode, ' +
        'takeover_timeout_minutes, approval_mode, response_delay_seconds, updated_at',
      )
      .single()

    if (updateResult.error) {
      const errMsg = updateResult.error.message
      const errCode = updateResult.error.code
      if (
        errMsg.includes('approval_mode') || 
        errMsg.includes('response_delay_seconds') || 
        errCode === '42703'
      ) {
        const retryUpdates = { ...updates }
        delete retryUpdates.approval_mode
        delete retryUpdates.response_delay_seconds

        updateResult = await supabaseAdmin()
          .from('ai_agents')
          .update(retryUpdates)
          .eq('id', id)
          .select(
            'id, account_id, name, description, is_active, system_prompt, ' +
            'prompt_personality, prompt_goal, prompt_general_info, ' +
            'model_name, temperature, max_tokens, channels, takeover_mode, ' +
            'takeover_timeout_minutes, updated_at',
          )
          .single()

        if (updateResult.data) {
          updateResult.data.approval_mode = false
          updateResult.data.response_delay_seconds = 0
        }
      }
    }

    const { data: agent, error } = updateResult

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

    // Handle Skills assignments
    if ('skills' in body && Array.isArray(body.skills)) {
      const db = supabaseAdmin()
      await db.from('ai_agent_skills').delete().eq('agent_id', id)
      
      // skill_configs is an optional map of { [skill_type]: { ...config } }
      const skillConfigs: Record<string, Record<string, unknown>> =
        (body.skill_configs as Record<string, Record<string, unknown>>) ?? {}

      if (body.skills.length > 0) {
        const skillInserts = body.skills.map((skillType: string) => ({
          agent_id: id,
          skill_type: skillType,
          skill_config: skillConfigs[skillType] ?? {},
          is_enabled: true
        }))
        await db.from('ai_agent_skills').insert(skillInserts)
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
