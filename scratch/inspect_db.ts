import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing required environment variables')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function inspect(): Promise<void> {
  console.log('// ============ ACCOUNT INSPECTION ============')
  const { data: accounts, error: accError } = await supabase
    .from('accounts')
    .select('id, name')
    .limit(10)

  if (accError) {
    console.error('Error fetching accounts:', accError)
  } else {
    console.log('Accounts found:', accounts)
  }

  console.log('\n// ============ AGENT INSPECTION ============')
  const { data: agents, error: agentError } = await supabase
    .from('ai_agents')
    .select('id, name, account_id, is_active, prompt_personality, prompt_goal, prompt_general_info')
    .limit(5)

  if (agentError) {
    console.error('Error fetching agents:', agentError)
  } else {
    console.log('Agents found:', agents)
  }

  console.log('\n// ============ KB INSPECTION ============')
  const { data: kbs, error: kbError } = await supabase
    .from('ai_knowledge_bases')
    .select('id, name, account_id')
    .limit(5)

  if (kbError) {
    console.error('Error fetching knowledge bases:', kbError)
  } else {
    console.log('Knowledge bases found:', kbs)
  }
}

inspect().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
