import { NextResponse } from 'next/server'
import { google } from 'googleapis'
import { createClient } from '@supabase/supabase-js'

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
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  if (error) {
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/settings/integrations?error=${error}`)
  }

  if (!code || !state) {
    return NextResponse.json({ error: 'Missing code or state' }, { status: 400 })
  }

  let accountId: string
  let redirectUri: string

  try {
    const decodedState = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'))
    accountId = decodedState.accountId
    redirectUri = decodedState.redirectUri
  } catch (err) {
    console.error('Failed to parse state:', err)
    return NextResponse.json({ error: 'Invalid state' }, { status: 400 })
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/integrations/google/callback`
  )

  try {
    const { tokens } = await oauth2Client.getToken(code)
    oauth2Client.setCredentials(tokens)

    // Fetch user info to store the provider_account_id (email)
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client })
    const userInfo = await oauth2.userinfo.get()

    const db = supabaseAdmin()

    // Store in the database
    const { error: dbError } = await db
      .from('connected_accounts')
      .upsert({
        account_id: accountId,
        provider: 'google',
        provider_account_id: userInfo.data.email || userInfo.data.id || 'unknown',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
        scopes: tokens.scope ? tokens.scope.split(' ') : [],
      }, { onConflict: 'account_id,provider' })

    if (dbError) {
      throw dbError
    }

    return NextResponse.redirect(`${redirectUri}?success=true`)
  } catch (err) {
    console.error('Failed to exchange token:', err)
    return NextResponse.redirect(`${redirectUri}?error=auth_failed`)
  }
}
