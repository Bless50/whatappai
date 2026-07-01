import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing Supabase credentials in env!');
  process.exit(1);
}

// We instantiate the client pointing to the 'supabase_migrations' schema
const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  db: { schema: 'supabase_migrations' }
});

async function run() {
  console.log('Fetching migration history...');
  const { data, error } = await supabase
    .from('schema_migrations')
    .select('*')
    .order('version', { ascending: true });

  if (error) {
    console.error('Error fetching from schema_migrations:', error);
  } else {
    console.log('Migration history table content:');
    console.log(JSON.stringify(data, null, 2));
  }
}

run();
