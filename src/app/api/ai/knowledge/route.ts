/**
 * Knowledge Bases API — List and Create.
 *
 * GET  /api/ai/knowledge?account_id=... → list all KBs for the account
 * POST /api/ai/knowledge → create a new KB
 */

import { NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _admin: SupabaseClient | null = null
function supabaseAdmin() {
  if (!_admin) {
    _admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _admin
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const accountId = searchParams.get('account_id')

    if (!accountId) {
      return NextResponse.json({ error: 'account_id is required' }, { status: 400 })
    }

    const { data: kbs, error } = await supabaseAdmin()
      .from('ai_knowledge_bases')
      .select('id, name, description, created_at, updated_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[api/ai/knowledge] GET error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Optionally count chunks per KB
    const kbIds = kbs?.map((kb: { id: string }) => kb.id) ?? []
    let chunksCounts: Record<string, number> = {}
    if (kbIds.length > 0) {
      const { data: chunks } = await supabaseAdmin()
        .from('ai_knowledge_chunks')
        .select('knowledge_base_id')
        .in('knowledge_base_id', kbIds)
      
      chunksCounts = chunks?.reduce((acc: Record<string, number>, row: { knowledge_base_id: string }) => {
        acc[row.knowledge_base_id] = (acc[row.knowledge_base_id] || 0) + 1
        return acc
      }, {}) ?? {}
    }

    const enhancedKbs = kbs?.map((kb: { id: string; name: string; description: string | null; created_at: string; updated_at: string }) => ({
      ...kb,
      chunk_count: chunksCounts[kb.id] || 0
    }))

    return NextResponse.json({ knowledge_bases: enhancedKbs ?? [] })
  } catch (err) {
    console.error('[api/ai/knowledge] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { account_id, name, description } = body

    if (!account_id || !name) {
      return NextResponse.json({ error: 'account_id and name are required' }, { status: 400 })
    }

    const { data: kb, error } = await supabaseAdmin()
      .from('ai_knowledge_bases')
      .insert({
        account_id,
        name,
        description: description ?? null,
      })
      .select()
      .single()

    if (error) {
      console.error('[api/ai/knowledge] create error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ knowledge_base: kb }, { status: 201 })
  } catch (err) {
    console.error('[api/ai/knowledge] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
