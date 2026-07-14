/**
 * /api/whatsapp/gateway-proxy
 *
 * Server-side proxy that forwards requests from the browser to the
 * WhatsApp Gateway running on the VPS. This avoids cross-origin issues
 * (CORS, CSP) and DNS resolution problems on client networks.
 *
 * GET  ?action=status&accountId=xxx  → GET  gateway /api/session/status
 * POST ?action=connect               → POST gateway /api/session/connect
 * POST ?action=disconnect             → POST gateway /api/session/disconnect
 */

import { NextRequest, NextResponse } from 'next/server';

// ============ CONFIGURATION ============

const GATEWAY_URL = (
  process.env.WHATSAPP_GATEWAY_URL || 'http://localhost:3001'
).replace(/\/$/, '');

const GATEWAY_SECRET =
  process.env.WHATSAPP_GATEWAY_SECRET || '';

// ============ HELPERS ============

function gatewayHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (GATEWAY_SECRET) {
    headers['x-gateway-secret'] = GATEWAY_SECRET;
  }
  return headers;
}

// ============ GET HANDLER (status polling) ============

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');
  const accountId = searchParams.get('accountId');

  if (action !== 'status' || !accountId) {
    return NextResponse.json(
      { error: 'Missing action=status or accountId query parameter.' },
      { status: 400 }
    );
  }

  try {
    const res = await fetch(
      `${GATEWAY_URL}/api/session/status?accountId=${encodeURIComponent(accountId)}`,
      { headers: gatewayHeaders() }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => 'Unknown error');
      return NextResponse.json(
        { error: `Gateway responded with ${res.status}: ${text}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error('[gateway-proxy GET] Could not reach gateway:', err);
    return NextResponse.json(
      { error: 'Could not reach the WhatsApp Gateway.' },
      { status: 502 }
    );
  }
}

// ============ POST HANDLER (connect / disconnect) ============

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  if (!action || !['connect', 'disconnect'].includes(action)) {
    return NextResponse.json(
      { error: 'Missing or invalid action query parameter. Expected "connect" or "disconnect".' },
      { status: 400 }
    );
  }

  try {
    const body = await request.json();

    const res = await fetch(
      `${GATEWAY_URL}/api/session/${action}`,
      {
        method: 'POST',
        headers: gatewayHeaders(),
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return NextResponse.json(
        { error: data.error || `Gateway responded with ${res.status}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error(`[gateway-proxy POST /${action}] Could not reach gateway:`, err);
    return NextResponse.json(
      { error: 'Could not reach the WhatsApp Gateway.' },
      { status: 502 }
    );
  }
}
