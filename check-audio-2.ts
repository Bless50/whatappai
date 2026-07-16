import { createClient } from '@supabase/supabase-js'

import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
)

async function checkAudioMessages() {
  const { data, error } = await supabase
    .from('messages')
    .select('id, content_type, media_url, created_at')
    .eq('content_type', 'audio')
    .not('media_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(5)

  if (error) {
    console.error('Error fetching messages:', error)
    return
  }

  console.log('Audio messages with media_url:', JSON.stringify(data, null, 2))
}

checkAudioMessages()
