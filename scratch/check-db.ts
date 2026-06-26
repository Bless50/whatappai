import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function checkDB() {
  const { data, error } = await supabase
    .from('messages')
    .select('id, sender_type, message_id, content_text, created_at')
    .order('created_at', { ascending: false })
    .limit(10)

  if (error) {
    console.error('Error:', error)
  } else {
    console.log('Latest messages:', JSON.stringify(data, null, 2))
  }
}

checkDB()
