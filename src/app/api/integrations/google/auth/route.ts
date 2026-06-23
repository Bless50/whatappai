import { NextResponse } from 'next/server'
import { google } from 'googleapis'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const accountId = searchParams.get('account_id')
  const redirectUri = searchParams.get('redirect_uri') // Where to send the user back after saving to DB

  if (!accountId) {
    return NextResponse.json({ error: 'Missing account_id' }, { status: 400 })
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/integrations/google/callback`
  )

  const scopes = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
  ]

  // Pass accountId and redirectUri in state so callback has them
  const state = Buffer.from(JSON.stringify({ accountId, redirectUri })).toString('base64')

  const authorizationUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Get a refresh token
    scope: scopes,
    include_granted_scopes: true,
    prompt: 'consent', // Force consent screen so we always get a refresh token
    state,
  })

  return NextResponse.redirect(authorizationUrl)
}
