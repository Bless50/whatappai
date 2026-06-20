/**
 * AI Agent system type definitions.
 *
 * These mirror the Supabase schema from migration 024 (ai_agents_v2)
 * and the runtime types used by the agent engine, model client, and
 * skills system.
 *
 * Naming convention: AI-prefixed types for DB-row shapes; unprefixed
 * for runtime-only types (ChatMessage, SkillDefinition, etc.).
 */

// ============================================================
// DB Row Types (match migration 024)
// ============================================================

export type AIAgentChannel = 'whatsapp' | 'facebook' | 'instagram';
export type AITakeoverMode = 'timeout' | 'manual' | 'on_close';
export type AIConversationStatus = 'active' | 'paused' | 'disabled';

export interface AIAgent {
  id: string;
  account_id: string;
  name: string;
  description: string | null;
  avatar_url: string | null;
  is_active: boolean;
  system_prompt: string;
  model_name: string;
  temperature: number;
  max_tokens: number;
  /** Encrypted OpenRouter API key — decrypt before use. */
  openrouter_api_key: string | null;
  /** Legacy column name from migration 023; alias for openrouter_api_key. */
  openrouter_key: string | null;
  provider: string;
  channels: AIAgentChannel[];
  takeover_mode: AITakeoverMode;
  takeover_timeout_minutes: number;
  /** Legacy booking link from migration 023. */
  booking_link: string | null;
  created_at: string;
  updated_at: string;
}

export type AISkillType =
  | 'crm_lookup'
  | 'create_deal'
  | 'tag_contact'
  | 'book_appointment'
  | 'escalate'
  | 'update_contact';

export interface AIAgentSkill {
  id: string;
  agent_id: string;
  skill_type: AISkillType;
  skill_config: Record<string, unknown>;
  is_enabled: boolean;
  created_at: string;
}

export type KnowledgeSourceType = 'text' | 'pdf' | 'url' | 'faq' | 'gdoc';

export interface AIKnowledgeBase {
  id: string;
  account_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface AIKnowledgeChunk {
  id: string;
  knowledge_base_id: string;
  content: string;
  metadata: Record<string, unknown>;
  /** pgvector embedding — only populated server-side, never sent to client. */
  embedding?: number[];
  source_type: KnowledgeSourceType;
  source_name: string | null;
  token_count: number;
  created_at: string;
}

export interface AIAgentKnowledgeBase {
  agent_id: string;
  knowledge_base_id: string;
}

export type AppointmentStatus = 'confirmed' | 'cancelled' | 'completed' | 'no_show';

export interface AICalendar {
  id: string;
  account_id: string;
  name: string;
  timezone: string;
  /** Working hours per day. Keys are 3-letter day codes (mon-sun).
   *  Values are [start, end] in HH:mm format. Missing day = closed. */
  working_hours: Record<string, [string, string]>;
  slot_duration_minutes: number;
  buffer_minutes: number;
  created_at: string;
  updated_at: string;
}

export interface AIAppointment {
  id: string;
  calendar_id: string;
  contact_id: string | null;
  agent_id: string | null;
  conversation_id: string | null;
  title: string;
  starts_at: string;
  ends_at: string;
  status: AppointmentStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface AIConversationLog {
  id: string;
  agent_id: string;
  conversation_id: string;
  message_id: string | null;
  model_used: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_cost_usd: number;
  latency_ms: number;
  created_at: string;
}

// ============================================================
// Model Client Types (OpenRouter-compatible)
// ============================================================

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  /** Present when role is 'assistant' and the model wants to call tools. */
  tool_calls?: ToolCall[];
  /** Present when role is 'tool' — the id of the tool call this responds to. */
  tool_call_id?: string;
  /** Tool name, required when role is 'tool'. */
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * OpenAI-compatible function/tool definition sent to the model.
 * OpenRouter passes these through to the underlying model.
 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelConfig {
  /** OpenRouter model identifier, e.g. 'google/gemini-2.5-flash'. */
  model: string;
  temperature: number;
  max_tokens: number;
  /** Decrypted OpenRouter API key. */
  apiKey: string;
}

export interface ModelResponse {
  content: string | null;
  tool_calls: ToolCall[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  /** Model that actually ran (may differ from requested due to fallback). */
  model: string;
  /** Total generation cost in USD (from OpenRouter headers). */
  cost_usd: number;
  /** Response latency in milliseconds. */
  latency_ms: number;
}

// ============================================================
// Agent Engine Types
// ============================================================

/** Input to the AI agent dispatcher from the webhook. */
export interface AIDispatchInput {
  accountId: string;
  conversationId: string;
  contactId: string;
  messageText: string;
  /** Sender-of-record for bot messages (the WhatsApp config owner). */
  userId: string;
  /** Decrypted WhatsApp access token for sending replies. */
  accessToken: string;
  /** Message channel — currently always 'whatsapp'. */
  channel?: AIAgentChannel;
}

export interface AIDispatchResult {
  /** True if an AI agent handled the message. */
  handled: boolean;
  /** The agent that handled it, if any. */
  agentId?: string;
  /** Why the message wasn't handled, if applicable. */
  reason?: 'no_agent' | 'ai_paused' | 'ai_disabled' | 'no_api_key' | 'error';
}

// ============================================================
// Skills / Tools Types
// ============================================================

/** Context passed to every skill execution. */
export interface SkillContext {
  accountId: string;
  contactId: string;
  conversationId: string;
  agentId: string;
}

export interface SkillResult {
  success: boolean;
  /** Human-readable result sent back to the LLM as the tool response. */
  data: string;
  /** Optional structured data for logging. */
  metadata?: Record<string, unknown>;
}

/**
 * A registered skill. Each skill provides an OpenAI-compatible tool
 * definition and an execute function. The engine calls execute() when
 * the LLM invokes the tool, then feeds the result back to the LLM.
 */
export interface SkillDefinition {
  /** Matches the ai_agent_skills.skill_type column. */
  type: AISkillType;
  /** OpenAI function definition — sent to the model. */
  tool: ToolDefinition;
  /** Execute the skill. Must never throw — return { success: false } on error. */
  execute: (
    params: Record<string, unknown>,
    context: SkillContext,
  ) => Promise<SkillResult>;
}

// ============================================================
// Knowledge Base / RAG Types
// ============================================================

export interface RAGSearchResult {
  chunk_id: string;
  content: string;
  source_type: KnowledgeSourceType;
  source_name: string | null;
  /** Cosine similarity score (0-1, higher is better). */
  similarity: number;
}

export interface ChunkInput {
  content: string;
  sourceType: KnowledgeSourceType;
  sourceName: string;
  metadata?: Record<string, unknown>;
}
