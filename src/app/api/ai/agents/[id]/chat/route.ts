/**
 * Bot Playground Chat API.
 * POST /api/ai/agents/[id]/chat
 * Used for testing agents in the UI before deploying.
 */

import { NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { buildPrompt } from '@/lib/ai/prompt-builder'
import { callModel } from '@/lib/ai/model-client'
import { generateEmbeddings } from '@/lib/ai/embedding-client'

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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: agentId } = await params
    const body = await request.json()
    const { message, history } = body
    
    const db = supabaseAdmin()

    // 1. Fetch Agent
    const { data: agent, error: agentError } = await db
      .from('ai_agents')
      .select('*')
      .eq('id', agentId)
      .single()

    if (agentError || !agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    const apiKey = agent.openrouter_api_key ?? agent.openrouter_key
    console.log('[playground] DB columns present:', {
      has_openrouter_api_key: 'openrouter_api_key' in agent,
      has_openrouter_key: 'openrouter_key' in agent,
      apiKey_exists: !!apiKey,
      apiKey_length: apiKey?.length ?? 0,
      apiKey_prefix: apiKey?.substring(0, 10) ?? 'N/A',
    })
    if (!apiKey) {
      return NextResponse.json({ error: 'Agent has no API key configured' }, { status: 400 })
    }
    let decryptedKey: string
    try {
      decryptedKey = decrypt(apiKey)
      console.log('[playground] Decrypted key prefix:', decryptedKey.substring(0, 12), '... length:', decryptedKey.length)
    } catch (decryptErr) {
      console.error('[playground] Failed to decrypt API key:', decryptErr)
      return NextResponse.json({ error: 'Failed to decrypt API key. Try re-saving it.' }, { status: 500 })
    }

    // 2. RAG - Search Knowledge Bases
    let knowledgeContext: string | undefined
    interface Source {
      source_name: string | null
      source_type: string | null
      similarity: number
    }
    let sources: Source[] = []
    
    const { data: kbLinks } = await db
      .from('ai_agent_knowledge_bases')
      .select('knowledge_base_id')
      .eq('agent_id', agent.id)
      .limit(1)

    if (kbLinks && kbLinks.length > 0 && message.trim()) {
      try {
        const results = await generateEmbeddings([message], decryptedKey)
        if (results && results.length > 0) {
          const queryVector = `[${results[0].embedding.join(',')}]`
          const { data: chunks } = await db.rpc('match_knowledge_chunks', {
            query_embedding: queryVector,
            match_agent_id: agentId,
            match_count: 5,
            similarity_threshold: 0.65
          })

          if (chunks && chunks.length > 0) {
            sources = chunks.map((c: { source_name: string | null; source_type: string | null; similarity: number }) => ({
              source_name: c.source_name,
              source_type: c.source_type,
              similarity: c.similarity
            }))
            
            knowledgeContext = chunks.map((c: { content: string; source_name: string | null }) => 
              `${c.content}${c.source_name ? ` (Source: ${c.source_name})` : ''}`
            ).join('\n\n---\n\n')
          }
        }
      } catch (err) {
        console.error('[playground] RAG error:', err)
      }
    }

    // 3. Build Prompt (using empty/mock IDs for CRM data since it's a test)
    let masterPrompt = agent.system_prompt || ''
    
    // Stitch the GHL-style structured prompt fields together if any are present
    if (agent.prompt_personality || agent.prompt_goal || agent.prompt_general_info) {
      const parts = []
      if (agent.prompt_personality) parts.push(`## Personality\n${agent.prompt_personality}`)
      if (agent.prompt_goal) parts.push(`## Goal\n${agent.prompt_goal}`)
      if (agent.prompt_general_info) parts.push(`## General Information\n${agent.prompt_general_info}`)
      masterPrompt = parts.join('\n\n')
    }

    const messages = await buildPrompt({
      systemPrompt: masterPrompt,
      contactId: '00000000-0000-0000-0000-000000000000', // Mock
      conversationId: '00000000-0000-0000-0000-000000000000', // Mock
      accountId: agent.account_id,
      inboundText: message,
      knowledgeContext,
    })

    // Inject history
    // Prompt builder puts system prompt at [0], then history, then user message.
    // For playground, we can just insert the provided history before the final user message.
    const finalMessages = [
      messages[0], // System
      ...history.map((m: { role: string; content: string }) => ({ role: m.role, content: m.content })),
      messages[messages.length - 1] // User current message
    ]

    // 4. Call LLM
    const response = await callModel(
      {
        model: agent.model_name,
        temperature: agent.temperature,
        max_tokens: agent.max_tokens,
        apiKey: decryptedKey,
      },
      finalMessages
    )

    return NextResponse.json({
      reply: response.content,
      sources,
      usage: response.usage
    })

  } catch (err) {
    console.error('[playground] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
