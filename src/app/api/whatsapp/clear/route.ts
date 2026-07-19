import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function DELETE(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
      
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const { searchParams } = new URL(request.url)
    const conversationId = searchParams.get('conversationId')

    if (!conversationId) {
      return NextResponse.json({ error: 'conversationId is required' }, { status: 400 })
    }

    const { data: conv } = await supabase
      .from('conversations')
      .select('id, contact_id, account_id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();

    if (!conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const { data: contact } = await supabase
      .from('contacts')
      .select('phone_number')
      .eq('id', conv.contact_id)
      .maybeSingle();

    if (contact && contact.phone_number) {
      const GATEWAY_URL = process.env.WHATSAPP_GATEWAY_URL || 'http://localhost:3005';
      fetch(`${GATEWAY_URL}/api/messages/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: conv.account_id,
          to: contact.phone_number
        })
      }).catch(err => console.error('[api/whatsapp/clear] Gateway clear failed:', err));
    }

    const { error } = await supabase
      .from('conversations')
      .delete()
      .eq('id', conversationId);

    if (error) {
      console.error('[api/whatsapp/clear] delete error:', error);
      return NextResponse.json({ error: 'Failed to delete conversation' }, { status: 500 })
    }

    return NextResponse.json({ success: true }, { status: 200 })
  } catch (err) {
    const error = err as Error
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
