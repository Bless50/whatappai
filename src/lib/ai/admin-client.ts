import { createClient } from '@supabase/supabase-js'

// Lazy-initialized Supabase admin client for the AI module.
// Bypasses RLS — used only by server-side engine code (agent
// dispatcher, skills, knowledge base). Same pattern as
// src/lib/automations/admin-client.ts and src/lib/flows/admin-client.ts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: any = null

export function supabaseAdmin() {
  if (!_client) {
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _client
}
