// ============================================================
// GET /api/v1/conversations/{id}/messages — list a conversation's
// messages (scope: messages:read), newest first, keyset-paginated.
//
// The conversation is verified to belong to the key's account before
// any message is returned — a foreign or unknown id → 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  parseListParams,
  keysetFilter,
  buildPage,
} from '@/lib/api/v1/pagination';
import { serializeMessage } from '@/lib/api/v1/conversations';
import type { Message } from '@/types';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'messages:read');
    const { id } = await params;
    const { limit, cursor } = parseListParams(request);

    // Gate on account ownership of the conversation first.
    const { data: conv } = await ctx.supabase
      .from('conversations')
      .select('id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!conv) return fail('not_found', 'Conversation not found', 404);

    let query = ctx.supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/messages] list error:', error);
      return fail('internal', 'Failed to list messages', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(
      items.map((m) => serializeMessage(m as unknown as Message)),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'messages:write');
    const { id } = await params;

    const { data: conv } = await ctx.supabase
      .from('conversations')
      .select('id, contact_id, account_id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (!conv) return fail('not_found', 'Conversation not found', 404);

    const { data: contact } = await ctx.supabase
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
      }).catch(err => console.error('[api/v1/messages] Gateway clear failed:', err));
    }

    const { error } = await ctx.supabase
      .from('messages')
      .delete()
      .eq('conversation_id', id);

    if (error) {
      console.error('[api/v1/messages] delete error:', error);
      return fail('internal', 'Failed to delete messages', 500);
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
