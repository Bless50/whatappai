import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { decrypt } from '../src/lib/whatsapp/encryption';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function main() {
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const { data: agents, error } = await supabase
    .from('ai_agents')
    .select('*')
    .not('openrouter_key', 'is', null)
    .limit(1);

  if (error || !agents || agents.length === 0) {
    console.error('No configured agents with API key found:', error);
    return;
  }

  const agent = agents[0];
  console.log(`Using agent: ${agent.name} (${agent.id})`);
  console.log(`Configured model in DB: ${agent.model_name}`);
  const rawKey = agent.openrouter_api_key ?? agent.openrouter_key;
  if (!rawKey) {
    console.error('No key found in agent object. Keys are:', Object.keys(agent));
    return;
  }
  const openrouterKey = decrypt(rawKey);
  console.log('Decrypted API Key length:', openrouterKey.length);

  // Test 1: Simple text request to deepseek/deepseek-v4-pro
  console.log('\n--- Test 1: Text message to deepseek/deepseek-v4-pro ---');
  const res1 = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openrouterKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-pro',
      messages: [{ role: 'user', content: 'Say hello' }],
    }),
  });

  console.log('Test 1 Status:', res1.status, res1.statusText);
  const body1 = await res1.text();
  console.log('Test 1 Response:', body1);

  // Test 2: Simple text request to deepseek/deepseek-v4-flash
  console.log('\n--- Test 2: Text message to deepseek/deepseek-v4-flash ---');
  const res2 = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openrouterKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Say hello' }],
    }),
  });

  console.log('Test 2 Status:', res2.status, res2.statusText);
  const body2 = await res2.text();
  console.log('Test 2 Response:', body2);
}

main().catch(console.error);
