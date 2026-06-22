/**
 * Knowledge Base Content Ingestion API.
 *
 * POST /api/ai/knowledge/[id]/content
 * Uploads data (URL, Text, FAQs, or PDF), parses it, chunks it,
 * generates vector embeddings, and saves to ai_knowledge_chunks.
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { parsePdf, scrapeUrl, formatFaq } from '@/lib/ai/knowledge-parsers'
import { processAndEmbedText } from '@/lib/ai/embedding-client'

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
    const { id: knowledgeBaseId } = await params
    const db = supabaseAdmin()

    // 1. Verify KB exists and get account ID
    const { data: kb, error: kbError } = await db
      .from('ai_knowledge_bases')
      .select('account_id')
      .eq('id', knowledgeBaseId)
      .single()

    if (kbError || !kb) {
      return NextResponse.json({ error: 'Knowledge base not found' }, { status: 404 })
    }

    // 2. Find an OpenRouter API key from the account's agents to use for embeddings
    const { data: agents } = await db
      .from('ai_agents')
      .select('openrouter_key')
      .eq('account_id', kb.account_id)
      .not('openrouter_key', 'is', null)
      .limit(1)

    if (!agents || agents.length === 0 || !agents[0].openrouter_key) {
      return NextResponse.json(
        { error: 'No OpenRouter API key found. Please configure an AI agent with an API key first.' },
        { status: 400 }
      )
    }

    const openrouterKey = decrypt(agents[0].openrouter_key)

    // 3. Process the form data
    const formData = await request.formData()
    const sourceType = formData.get('source_type') as string // 'text', 'url', 'faq', 'pdf'
    
    let rawText = ''
    let sourceName = ''

    if (sourceType === 'pdf') {
      const file = formData.get('file') as File
      if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
      const buffer = Buffer.from(await file.arrayBuffer())
      rawText = await parsePdf(buffer)
      sourceName = file.name
    } else if (sourceType === 'url') {
      const url = formData.get('url') as string
      if (!url) return NextResponse.json({ error: 'No URL provided' }, { status: 400 })
      rawText = await scrapeUrl(url)
      sourceName = url
    } else if (sourceType === 'faq') {
      const faqsJson = formData.get('faqs') as string
      if (!faqsJson) return NextResponse.json({ error: 'No FAQs provided' }, { status: 400 })
      const faqs = JSON.parse(faqsJson)
      rawText = formatFaq(faqs)
      sourceName = 'FAQ Document'
    } else if (sourceType === 'text') {
      rawText = formData.get('text') as string
      sourceName = (formData.get('title') as string) || 'Text Snippet'
      if (!rawText) return NextResponse.json({ error: 'No text provided' }, { status: 400 })
    } else {
      return NextResponse.json({ error: 'Invalid source_type' }, { status: 400 })
    }

    if (!rawText.trim()) {
      return NextResponse.json({ error: 'Extracted text is empty' }, { status: 400 })
    }

    // 4. Chunk and embed the text
    const chunks = await processAndEmbedText(rawText, openrouterKey)

    // 5. Save chunks to the database
    const insertData = chunks.map(chunk => ({
      knowledge_base_id: knowledgeBaseId,
      content: chunk.text,
      // pgvector requires stringified arrays
      embedding: `[${chunk.embedding.join(',')}]`,
      source_type: sourceType,
      source_name: sourceName,
      token_count: chunk.tokens,
    }))

    const { error: insertError } = await db
      .from('ai_knowledge_chunks')
      .insert(insertData)

    if (insertError) {
      console.error('[api/ai/knowledge/content] insert error:', insertError)
      return NextResponse.json({ error: 'Failed to save chunks to database' }, { status: 500 })
    }

    return NextResponse.json({ 
      success: true, 
      chunks_processed: chunks.length,
      source_name: sourceName
    }, { status: 201 })

  } catch (err) {
    console.error('[api/ai/knowledge/content] POST error:', err)
    return NextResponse.json({ 
      error: err instanceof Error ? err.message : 'Internal server error' 
    }, { status: 500 })
  }
}
