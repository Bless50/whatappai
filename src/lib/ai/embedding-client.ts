/**
 * Embedding & Chunking utilities.
 *
 * Provides functions to:
 * 1. Split text into overlapping chunks
 * 2. Generate embeddings via OpenRouter (using text-embedding-3-small)
 */


const EMBEDDING_MODEL = 'openai/text-embedding-3-small'
const OPENROUTER_EMBEDDING_URL = 'https://openrouter.ai/api/v1/embeddings'

function chunkArray<T>(array: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

interface EmbeddingResult {
  embedding: number[]
  text: string
  tokens: number
}

/**
 * Generate vector embeddings for a list of text chunks using OpenRouter.
 */
export async function generateEmbeddings(
  texts: string[],
  openrouterKey: string
): Promise<EmbeddingResult[]> {
  if (!texts.length) return []

  // The OpenAI spec (which OpenRouter follows) accepts an array of strings
  const response = await fetch(OPENROUTER_EMBEDDING_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openrouterKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.NEXT_PUBLIC_SITE_URL ?? 'https://wacrm.local',
      'X-Title': 'WhatsApp CRM',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error('[ai/embeddings] OpenRouter API error:', response.status, errorText)
    throw new Error(`Embedding API failed: ${response.status} ${errorText}`)
  }

  const data = await response.json()

  // Map results back to original text
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return data.data.map((item: any, i: number) => ({
    embedding: item.embedding,
    text: texts[i],
    // Approximate tokens if not provided per-item
    tokens: item.prompt_tokens ?? Math.ceil(texts[i].length / 4),
  }))
}

/**
 * Simple recursive character text splitter.
 * Splits text into chunks of roughly `chunkSize` characters,
 * with an `overlap` to preserve context across boundaries.
 */
export function splitTextIntoChunks(
  text: string,
  chunkSize: number = 2000,
  overlap: number = 200
): string[] {
  // 1. Remove excess whitespace
  const cleanText = text.replace(/\s+/g, ' ').trim()
  if (!cleanText) return []

  const chunks: string[] = []
  let i = 0

  while (i < cleanText.length) {
    // If remaining text is smaller than chunk size, take it all
    if (i + chunkSize >= cleanText.length) {
      chunks.push(cleanText.slice(i))
      break
    }

    // Try to find a logical break point near the chunk size limit
    const endPos = i + chunkSize
    
    // Look backwards for a sentence boundary (.!?)
    let breakPoint = -1
    for (let j = endPos; j > endPos - (chunkSize / 4); j--) {
      if (['.', '!', '?'].includes(cleanText[j]) && cleanText[j + 1] === ' ') {
        breakPoint = j + 1
        break
      }
    }

    // If no sentence boundary found, look for a space
    if (breakPoint === -1) {
      for (let j = endPos; j > endPos - (chunkSize / 4); j--) {
        if (cleanText[j] === ' ') {
          breakPoint = j
          break
        }
      }
    }

    // If still no logical break, hard cut
    if (breakPoint === -1) {
      breakPoint = endPos
    }

    chunks.push(cleanText.slice(i, breakPoint).trim())
    
    // Move forward, subtracting overlap
    i = breakPoint - overlap
    
    // Prevent infinite loops if overlap >= breakPoint advancement
    if (i <= chunks[chunks.length - 1].length - chunkSize) {
      i = breakPoint
    }
  }

  return chunks.filter(c => c.length > 50) // Filter out tiny fragments
}

/**
 * Batch generate embeddings to avoid API payload limits.
 */
export async function processAndEmbedText(
  text: string,
  openrouterKey: string
): Promise<EmbeddingResult[]> {
  const chunks = splitTextIntoChunks(text)
  
  // Process in batches of 10 to avoid overwhelming the API
  const batches = chunkArray(chunks, 10)
  const results: EmbeddingResult[] = []

  for (const batch of batches) {
    const batchEmbeddings = await generateEmbeddings(batch, openrouterKey)
    results.push(...batchEmbeddings)
  }

  return results
}
