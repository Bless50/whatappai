import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { generateEmbeddings } from '@/lib/ai/embedding-client'

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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: messageUuid } = await params
    const body = await request.json()
    const { rating, feedbackText, correctedResponse } = body

    if (!rating || !['good', 'bad'].includes(rating)) {
      return NextResponse.json({ error: 'Valid rating (good/bad) is required' }, { status: 400 })
    }

    const db = supabaseAdmin()

    // 1. Fetch message and conversation to locate the agent
    const { data: message, error: msgError } = await db
      .from('messages')
      .select('*, conversations(account_id, ai_agent_id)')
      .eq('id', messageUuid)
      .single()

    if (msgError || !message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    const conversation = message.conversations
    const agentId = conversation.ai_agent_id

    // 2. Update message feedback fields
    const { error: updateError } = await db
      .from('messages')
      .update({
        ai_feedback_rating: rating,
        ai_feedback_text: feedbackText || null,
        ai_corrected_text: correctedResponse || null,
      })
      .eq('id', messageUuid)

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    // 3. If correction is provided and agent exists, feed it into knowledge base
    if (rating === 'bad' && correctedResponse && agentId) {
      // Fetch agent to get OpenRouter Key and linked KBs
      const { data: agent } = await db
        .from('ai_agents')
        .select('*, ai_agent_knowledge_bases(knowledge_base_id)')
        .eq('id', agentId)
        .single()

      if (agent) {
        const apiKey = agent.openrouter_api_key ?? agent.openrouter_key
        const decryptedKey = apiKey ? decrypt(apiKey) : null

        if (decryptedKey) {
          // Find customer's inbound message immediately preceding the bot's response
          const { data: inboundMsg } = await db
            .from('messages')
            .select('content_text')
            .eq('conversation_id', message.conversation_id)
            .eq('sender_type', 'customer')
            .lt('created_at', message.created_at)
            .order('created_at', { descending: true })
            .limit(1)
            .maybeSingle()

          const customerQuery = inboundMsg?.content_text || 'Customer query'
          
          // Formulate Q&A text chunk
          const chunkText = `Q: ${customerQuery}\nA: ${correctedResponse}\nFeedback note: ${feedbackText || 'Response corrected by operator.'}`

          // Generate vector embedding
          let embeddingResults
          try {
            embeddingResults = await generateEmbeddings([chunkText], decryptedKey)
          } catch (embedErr) {
            console.error('[messages/feedback] Failed to generate embedding:', embedErr)
          }

          if (embeddingResults && embeddingResults.length > 0) {
            const embedding = embeddingResults[0].embedding
            const queryVector = `[${embedding.join(',')}]`

            // Identify or create the destination knowledge base
            let kbId = agent.ai_agent_knowledge_bases?.[0]?.knowledge_base_id

            if (!kbId) {
              const { data: defaultKb } = await db
                .from('ai_knowledge_bases')
                .select('id')
                .eq('account_id', agent.account_id)
                .eq('name', 'AI Corrections')
                .maybeSingle()

              if (defaultKb) {
                kbId = defaultKb.id
              } else {
                const { data: newKb } = await db
                  .from('ai_knowledge_bases')
                  .insert({
                    account_id: agent.account_id,
                    name: 'AI Corrections',
                    description: 'Auto-generated knowledge base for AI corrections and brand adjustments.'
                  })
                  .select('id')
                  .single()
                kbId = newKb?.id
              }

              if (kbId) {
                // Link knowledge base to agent
                await db.from('ai_agent_knowledge_bases').insert({
                  agent_id: agent.id,
                  knowledge_base_id: kbId
                })
              }
            }

            if (kbId) {
              // Insert the corrected chunk
              const { error: chunkError } = await db
                .from('ai_knowledge_chunks')
                .insert({
                  knowledge_base_id: kbId,
                  content: chunkText,
                  embedding: queryVector,
                  source_type: 'faq',
                  source_name: 'Human Correction',
                  token_count: embeddingResults[0].tokens
                })

              if (chunkError) {
                console.error('[messages/feedback] Failed to save correction chunk:', chunkError)
              } else {
                console.log(`[messages/feedback] Saved correction chunk to KB: ${kbId}`)
              }
            }
          }
        }
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[messages/feedback] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
