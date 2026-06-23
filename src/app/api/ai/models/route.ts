/**
 * AI Models API — Proxied OpenRouter models list with server-side caching.
 *
 * GET /api/ai/models          → returns all text-capable models
 * GET /api/ai/models?search=  → filters models by name (case-insensitive)
 *
 * The upstream response from OpenRouter is cached in-memory for 1 hour
 * to avoid redundant external calls on every request.
 */

import { NextResponse } from 'next/server'

// ============ TYPES ============

/** Shape of a single model from the OpenRouter API */
interface OpenRouterModel {
  id: string
  name: string
  context_length: number
  pricing: {
    prompt: string
    completion: string
  }
  /** Modalities or architecture info — used to filter image-only models */
  architecture?: {
    modality?: string
    input_modalities?: string[]
    output_modalities?: string[]
  }
}

/** Full response envelope from OpenRouter */
interface OpenRouterResponse {
  data: OpenRouterModel[]
}

/** Simplified model shape returned by our API */
interface SimplifiedModel {
  id: string
  name: string
  context_length: number
  pricing: {
    prompt: string
    completion: string
  }
  provider: string
}

// ============ IN-MEMORY CACHE ============

const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

let cachedModels: SimplifiedModel[] | null = null
let cachedAt = 0

// ============ HELPERS ============

/**
 * Extract the provider slug from a model id.
 * e.g. 'google/gemini-2.5-flash' → 'google'
 *      'openai/gpt-4o'           → 'openai'
 */
function extractProvider(modelId: string): string {
  const slashIndex = modelId.indexOf('/')
  return slashIndex > 0 ? modelId.substring(0, slashIndex) : modelId
}

/**
 * Returns true if the model supports text completions.
 * We filter out models that are explicitly image-only or lack text output.
 */
function supportsTextCompletions(model: OpenRouterModel): boolean {
  const arch = model.architecture

  // If no architecture info is provided, assume text-capable
  if (!arch) return true

  // Check output modalities — must include 'text'
  if (arch.output_modalities && arch.output_modalities.length > 0) {
    return arch.output_modalities.includes('text')
  }

  // Legacy modality field — skip if explicitly image-only
  if (arch.modality === 'image->image' || arch.modality === 'image->text') {
    // 'image->text' is vision (text output), which is fine
    // 'image->image' is image generation only — skip it
    return arch.modality !== 'image->image'
  }

  return true
}

/**
 * Fetch, transform, sort and cache the models list from OpenRouter.
 */
async function fetchAndCacheModels(): Promise<SimplifiedModel[]> {
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: {
      'Accept': 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error(
      `OpenRouter API responded with ${response.status}: ${response.statusText}`,
    )
  }

  const json = (await response.json()) as OpenRouterResponse

  if (!json.data || !Array.isArray(json.data)) {
    throw new Error('Unexpected response shape from OpenRouter API')
  }

  // ---- Filter → Transform → Sort ----
  const models: SimplifiedModel[] = json.data
    .filter(supportsTextCompletions)
    .map((model) => ({
      id: model.id,
      name: model.name,
      context_length: model.context_length,
      pricing: {
        prompt: model.pricing?.prompt ?? '0',
        completion: model.pricing?.completion ?? '0',
      },
      provider: extractProvider(model.id),
    }))
    .sort((a, b) => {
      // Primary sort: provider alphabetically
      const providerCmp = a.provider.localeCompare(b.provider)
      if (providerCmp !== 0) return providerCmp
      // Secondary sort: name alphabetically
      return a.name.localeCompare(b.name)
    })

  // Persist to module-level cache
  cachedModels = models
  cachedAt = Date.now()

  return models
}

/**
 * Returns the models list, either from cache or by fetching fresh data.
 */
async function getModels(): Promise<SimplifiedModel[]> {
  const isCacheValid = cachedModels !== null && Date.now() - cachedAt < CACHE_TTL_MS

  if (isCacheValid) {
    return cachedModels!
  }

  return fetchAndCacheModels()
}

// ============ ROUTE HANDLER ============

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search')?.trim() ?? ''

    let models = await getModels()

    // Apply optional search filter (case-insensitive substring match on name)
    if (search.length > 0) {
      const lowerSearch = search.toLowerCase()
      models = models.filter(
        (m) => m.name.toLowerCase().includes(lowerSearch),
      )
    }

    return NextResponse.json(
      { models, count: models.length },
      {
        status: 200,
        headers: {
          // Let browsers/CDNs cache for 5 minutes, serve stale for 1 hour
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600',
        },
      },
    )
  } catch (err) {
    console.error('[api/ai/models] GET error:', err)

    const message =
      err instanceof Error ? err.message : 'Failed to fetch models'

    return NextResponse.json(
      { error: message },
      { status: 502 },
    )
  }
}
