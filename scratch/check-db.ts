import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function fixGhostMessages() {
  // Find bot messages that still have generated message_ids (never got a real Baileys ID)
  // These are messages that were inserted into the DB but never actually delivered
  const { data: ghostMessages, error } = await supabase
    .from('messages')
    .select('id, message_id, content_text, status, created_at')
    .eq('sender_type', 'bot')
    .eq('status', 'sent')
    .like('message_id', '3EB0%')  // Generated IDs start with 3EB0
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Error finding ghost messages:', error)
    return
  }

  console.log(`Found ${ghostMessages?.length ?? 0} bot messages with generated IDs:`)
  for (const msg of ghostMessages ?? []) {
    // Generated IDs are exactly 22 chars (3EB0 + 18 hex chars)
    // Real Baileys IDs may vary but are typically different
    const isGenerated = /^3EB0[A-F0-9]{18}$/.test(msg.message_id)
    console.log(`  ${msg.message_id} (${isGenerated ? 'GENERATED - never delivered' : 'possibly real'}) - ${msg.created_at}`)
    console.log(`    Preview: "${msg.content_text?.substring(0, 60)}..."`)
  }
}

fixGhostMessages()
