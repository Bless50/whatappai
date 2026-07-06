/**
 * OpenRouter LLM client.
 *
 * All AI model calls in the CRM go through this module. OpenRouter
 * provides a single API endpoint that routes to 200+ models (GPT-4o,
 * Claude, Gemini, DeepSeek, Llama, etc.) — the user picks their
 * model in the agent config, brings their own OpenRouter API key,
 * and this client handles the rest.
 *
 * API reference: https://openrouter.ai/docs/api-reference/chat-completion
 *
 * The interface is OpenAI-compatible (same request/response shapes),
 * so switching to a direct OpenAI/Anthropic endpoint in the future
 * would be a minimal change.
 */

import type {
  ChatMessage,
  ModelConfig,
  ModelResponse,
  ToolDefinition,
} from './types'

// ============================================================
// Constants
// ============================================================

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions'

/** Maximum retries on transient failures (429, 502, 503). */
const MAX_RETRIES = 2

/** Base delay in ms for exponential backoff. */
const RETRY_BASE_DELAY_MS = 1000

// ============================================================
// Public API
// ============================================================

/**
 * Send a chat completion request to OpenRouter.
 *
 * Supports function/tool calling: pass `tools` to let the model
 * invoke CRM skills. The engine handles the tool-call → execute →
 * feed-back-result loop; this function handles one round trip.
 *
 * Never throws on model errors — returns a structured response
 * with empty content so the caller can decide how to handle it.
 * Only throws on truly unrecoverable errors (missing API key,
 * network down after retries).
 */
export async function callModel(
  config: ModelConfig,
  messages: ChatMessage[],
  tools?: ToolDefinition[],
): Promise<ModelResponse> {
  if (!config.apiKey) {
    throw new Error('[ai/model-client] No API key provided')
  }

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: config.temperature,
    max_tokens: config.max_tokens,
  }

  // Only include tools if provided and non-empty — some models
  // don't support function calling and will error if the field is
  // present (even as an empty array).
  if (tools && tools.length > 0) {
    body.tools = tools
    body.tool_choice = 'auto'
  }

  const startMs = Date.now()
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(OPENROUTER_BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
          // OpenRouter uses these headers for analytics and rate
          // limiting. The site URL helps them identify the app;
          // the title shows in their dashboard.
          'HTTP-Referer': process.env.NEXT_PUBLIC_SITE_URL || 'https://localhost:3000',
          'X-Title': 'WaCRM AI Agent',
        },
        body: JSON.stringify(body),
      })

      // Retry on transient failures
      if (response.status === 429 || response.status === 502 || response.status === 503) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
        console.warn(
          `[ai/model-client] ${response.status} from OpenRouter, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        )
        await sleep(delay)
        continue
      }

      if (response.status === 402) {
        const errorBody = await response.text()
        try {
          const errObj = JSON.parse(errorBody)
          const errMsg = errObj?.error?.message || ''
          const match = errMsg.match(/can only afford (\d+)/)
          if (match && match[1]) {
            const affordableTokens = parseInt(match[1], 10)
            const currentMax = typeof body.max_tokens === 'number' ? body.max_tokens : 1024
            const nextMaxTokens = Math.max(50, Math.floor(affordableTokens * 0.95))
            if (nextMaxTokens < currentMax) {
              console.warn(
                `[ai/model-client] OpenRouter returned 402. Retrying with reduced max_tokens: ${nextMaxTokens} (was ${currentMax})`
              )
              body.max_tokens = nextMaxTokens
              continue
            }
          }
        } catch {
          // Ignore parsing error, throw original 402
        }
        throw new Error(
          `[ai/model-client] OpenRouter returned 402 (Payment Required): ${errorBody}`,
        )
      }

      if (!response.ok) {
        const errorBody = await response.text()
        throw new Error(
          `[ai/model-client] OpenRouter returned ${response.status}: ${errorBody}`,
        )
      }

      const data = await response.json() as OpenRouterResponse
      const latencyMs = Date.now() - startMs

      // Extract cost from OpenRouter's response metadata.
      // OpenRouter includes generation cost in the response body
      // under `usage` or in response headers.
      const costUsd = parseFloat(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (data as any)?.usage?.total_cost?.toString() ?? '0',
      )

      const choice = data.choices?.[0]
      if (!choice) {
        console.warn('[ai/model-client] No choices in response:', JSON.stringify(data))
        return {
          content: null,
          tool_calls: [],
          usage: data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          model: data.model ?? config.model,
          cost_usd: costUsd,
          latency_ms: latencyMs,
        }
      }

      return {
        content: choice.message?.content ?? null,
        tool_calls: choice.message?.tool_calls ?? [],
        usage: data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        model: data.model ?? config.model,
        cost_usd: costUsd,
        latency_ms: latencyMs,
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))

      // Don't retry non-transient errors
      if (
        lastError.message.includes('No API key') ||
        lastError.message.includes('returned 4') // 4xx errors (except 429 handled above)
      ) {
        throw lastError
      }

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
        console.warn(
          `[ai/model-client] Error, retrying in ${delay}ms:`,
          lastError.message,
        )
        await sleep(delay)
      }
    }
  }

  throw lastError ?? new Error('[ai/model-client] All retries exhausted')
}

// ============================================================
// OpenRouter Response Types
// ============================================================

interface OpenRouterResponse {
  id: string
  model: string
  choices: Array<{
    index: number
    message: {
      role: string
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: {
          name: string
          arguments: string
        }
      }>
    }
    finish_reason: string
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    total_cost?: any
  }
}

// ============================================================
// Helpers
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
