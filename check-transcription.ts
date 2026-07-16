import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
)

async function checkTranscription() {
  const { data: msgs, error } = await supabase
    .from('messages')
    .select('id, content_type, content_text, created_at')
    .eq('content_type', 'audio')
    .not('media_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)

  if (error || !msgs || msgs.length === 0) {
    console.error('No audio messages with media_url found.')
    return
  }

  console.log('Last audio message in DB:', msgs[0])
}

checkTranscription()
