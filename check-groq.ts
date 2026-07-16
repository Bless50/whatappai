import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
)

async function testGroqTranscription() {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    console.error('No GROQ_API_KEY found!')
    return
  }

  // Find the last audio message with a media_url
  const { data: msgs, error } = await supabase
    .from('messages')
    .select('media_url')
    .eq('content_type', 'audio')
    .not('media_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)

  if (error || !msgs || msgs.length === 0) {
    console.error('No audio messages with media_url found.')
    return
  }

  const mediaUrl = msgs[0].media_url
  console.log(`Downloading audio: ${mediaUrl}`)

  const res = await fetch(mediaUrl)
  if (!res.ok) {
    console.error(`Failed to fetch media: ${res.statusText}`)
    return
  }
  
  const arrayBuffer = await res.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const mimeType = res.headers.get('content-type') || 'audio/ogg'

  console.log(`Downloaded ${buffer.length} bytes, type: ${mimeType}. Sending to Groq...`)

  const formData = new FormData()
  const blob = new Blob([new Uint8Array(buffer)], { type: mimeType })
  formData.append('file', blob, 'voice-test.ogg')
  formData.append('model', 'whisper-large-v3-turbo')

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      body: formData
    })

    if (!groqRes.ok) {
      const errText = await groqRes.text()
      console.error(`Groq Whisper failed: ${groqRes.status} - ${errText}`)
      return
    }

    const result = await groqRes.json()
    console.log(`Success! Transcribed text: "${result.text}"`)
  } catch (err) {
    console.error('Exception during transcription:', err)
  }
}

testGroqTranscription()
