/**
 * Knowledge Base Details API.
 *
 * GET    /api/ai/knowledge/[id] → get KB details and its chunks
 * DELETE /api/ai/knowledge/[id] → delete KB
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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const db = supabaseAdmin()

    // 1. Get KB details
    const { data: kb, error: kbError } = await db
      .from('ai_knowledge_bases')
      .select('*')
      .eq('id', id)
      .single()

    if (kbError || !kb) {
      return NextResponse.json({ error: 'Knowledge base not found' }, { status: 404 })
    }

    // 2. Get chunks (we won't select the embedding vector to save bandwidth)
    const { data: chunks, error: chunksError } = await db
      .from('ai_knowledge_chunks')
      .select('id, content, source_type, source_name, token_count, created_at')
      .eq('knowledge_base_id', id)
      .order('created_at', { ascending: false })

    if (chunksError) {
      console.error('[api/ai/knowledge/[id]] chunks error:', chunksError)
      return NextResponse.json({ error: 'Failed to fetch chunks' }, { status: 500 })
    }

    return NextResponse.json({
      knowledge_base: kb,
      chunks: chunks ?? []
    })
  } catch (err) {
    console.error('[api/ai/knowledge/[id]] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    
    // Deleting the KB will cascade and delete all associated chunks 
    // and agent-KB assignments due to ON DELETE CASCADE
    const { error } = await supabaseAdmin()
      .from('ai_knowledge_bases')
      .delete()
      .eq('id', id)

    if (error) {
      console.error('[api/ai/knowledge/[id]] DELETE error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[api/ai/knowledge/[id]] DELETE error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
