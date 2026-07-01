import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { encrypt } from '@/lib/whatsapp/encryption'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _admin: any = null
function supabaseAdmin() {
  if (!_admin) {
    _admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _admin
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const accountId = searchParams.get('account_id')

  if (!accountId) {
    return NextResponse.json({ error: 'Missing account_id' }, { status: 400 })
  }

  const db = supabaseAdmin()

  const { data, error } = await db
    .from('connected_accounts')
    .select('id, provider, provider_account_id, created_at')
    .eq('account_id', accountId)

  if (error) {
    console.error('Failed to fetch integrations:', error)
    return NextResponse.json({ error: 'Failed to fetch integrations' }, { status: 500 })
  }

  return NextResponse.json({ integrations: data })
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { account_id, provider, provider_account_id, access_token } = body

    if (!account_id || !provider || !provider_account_id || !access_token) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // Encrypt token for security
    const encryptedToken = encrypt(access_token)

    const db = supabaseAdmin()

    const { data, error } = await db
      .from('connected_accounts')
      .upsert({
        account_id,
        provider,
        provider_account_id,
        access_token: encryptedToken,
        created_at: new Date().toISOString(),
      }, { onConflict: 'account_id,provider' })
      .select('id, provider, provider_account_id, created_at')
      .single()

    if (error) {
      console.error('Failed to create integration:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, integration: data })
  } catch (err) {
    console.error('Integrations POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')

  if (!id) {
    return NextResponse.json({ error: 'Missing integration id' }, { status: 400 })
  }

  const db = supabaseAdmin()

  const { error } = await db
    .from('connected_accounts')
    .delete()
    .eq('id', id)

  if (error) {
    console.error('Failed to delete integration:', error)
    return NextResponse.json({ error: 'Failed to delete integration' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
