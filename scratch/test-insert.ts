import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function test() {
  const { error } = await supabase.from('messages').insert({
    conversation_id: 'efc00db2-80cd-494d-aa43-bc56ee7f97d7', // the ID from the URL in screenshot
    sender_type: 'bot',
    content_type: 'text',
    content_text: 'Test message',
    message_id: 'test-' + Date.now(),
    status: 'sent',
    channel: 'whatsapp',
  })
  
  if (error) {
    console.error('Insert error:', error)
  } else {
    console.log('Insert successful!')
  }
}

test()
