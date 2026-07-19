import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
)

async function checkAgent() {
  const { data, error } = await supabase
    .from('ai_agents')
    .select('id, name, model_name')
    .eq('id', '24900216-bc58-4990-8a58-2ec370b9b59f')
    .single()
  console.log(data || error)
}
checkAgent()
