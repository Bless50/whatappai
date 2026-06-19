'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, Wifi, WifiOff, QrCode, RefreshCw, LogOut, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useAuth } from '@/hooks/use-auth';

// ============ TYPES ============

type SessionStatus = 'disconnected' | 'connecting' | 'qr_ready' | 'connected';

interface GatewayStatusResponse {
  status: SessionStatus;
  qr: string | null;
}

// Gateway base URL — reads from env or falls back to localhost:3001
const GATEWAY_URL =
  typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : 'http://localhost:3001';

// ============ COMPONENT ============

export function WebSessionConfig() {
  const { accountId, loading: authLoading } = useAuth();

  const [status, setStatus] = useState<SessionStatus>('disconnected');
  const [qr, setQr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // ============ POLLING ============

  const fetchStatus = useCallback(async () => {
    if (!accountId) return;
    try {
      const res = await fetch(
        `${GATEWAY_URL}/api/session/status?accountId=${encodeURIComponent(accountId)}`
      );
      if (!res.ok) return;
      const data: GatewayStatusResponse = await res.json();
      setStatus(data.status);
      setQr(data.qr);
    } catch {
      // Gateway may not be running — silently stay as disconnected
    }
  }, [accountId]);

  // Start polling when connecting or waiting for QR scan
  useEffect(() => {
    if (polling) {
      pollRef.current = setInterval(() => {
        fetchStatus();
      }, 2500);
    } else {
      if (pollRef.current) clearInterval(pollRef.current);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [polling, fetchStatus]);

  // Once connected, stop polling
  useEffect(() => {
    if (status === 'connected') {
      setPolling(false);
      toast.success('WhatsApp Web session connected!');
    }
  }, [status]);

  // Initial status check on mount
  useEffect(() => {
    if (!authLoading && accountId) {
      fetchStatus();
    }
  }, [authLoading, accountId, fetchStatus]);

  // ============ HANDLERS ============

  async function handleConnect() {
    if (!accountId) {
      toast.error('No account ID found. Make sure you are logged in.');
      return;
    }
    try {
      setLoading(true);
      const res = await fetch(`${GATEWAY_URL}/api/session/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'Failed to connect. Is the gateway running?');
        return;
      }

      const data: GatewayStatusResponse = await res.json();
      setStatus(data.status);
      setQr(data.qr);
      setPolling(true); // start polling for QR / connected state
    } catch {
      toast.error(
        'Could not reach the WhatsApp Gateway. Make sure the sidecar daemon is running on port 3001.'
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleDisconnect() {
    if (!accountId) return;
    if (!confirm('This will log out the linked phone. Continue?')) return;

    try {
      setLoading(true);
      const res = await fetch(`${GATEWAY_URL}/api/session/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'Failed to disconnect.');
        return;
      }

      setStatus('disconnected');
      setQr(null);
      setPolling(false);
      toast.success('WhatsApp Web session disconnected.');
    } catch {
      toast.error('Could not reach the gateway. Please check if it is running.');
    } finally {
      setLoading(false);
    }
  }

  function handleRefreshQr() {
    fetchStatus();
    toast.info('Refreshing QR code status...');
  }

  // ============ RENDER ============

  if (authLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px] mt-4">
      {/* Main panel */}
      <div className="space-y-6">
        {/* Status Banner */}
        <Alert
          className={
            status === 'connected'
              ? 'bg-emerald-950/30 border-emerald-700/50'
              : status === 'qr_ready' || status === 'connecting'
                ? 'bg-blue-950/30 border-blue-700/50'
                : 'bg-card border-border'
          }
        >
          <div className="flex items-center gap-2">
            {status === 'connected' ? (
              <Wifi className="size-4 text-emerald-400" />
            ) : status === 'connecting' || status === 'qr_ready' ? (
              <Loader2 className="size-4 animate-spin text-blue-400" />
            ) : (
              <WifiOff className="size-4 text-red-500" />
            )}
            <AlertTitle className="mb-0 text-foreground">
              {status === 'connected'
                ? 'Phone Linked — Session Active'
                : status === 'qr_ready'
                  ? 'Scan QR Code to Connect'
                  : status === 'connecting'
                    ? 'Connecting...'
                    : 'No Linked Phone'}
            </AlertTitle>
          </div>
          <AlertDescription className="text-muted-foreground mt-1">
            {status === 'connected'
              ? 'Your WhatsApp account is linked. Messages are being forwarded to the CRM.'
              : status === 'qr_ready'
                ? 'Open WhatsApp on your phone → Linked Devices → Link a Device and scan the QR code below.'
                : status === 'connecting'
                  ? 'Establishing connection with WhatsApp servers...'
                  : 'Click "Link Phone" to generate a QR code and connect an existing WhatsApp number.'}
          </AlertDescription>
        </Alert>

        {/* QR Code Display */}
        {(status === 'qr_ready' || status === 'connecting') && (
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-foreground flex items-center gap-2">
                <QrCode className="size-5" />
                QR Code
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                Scan this with WhatsApp on your phone to link your number.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-center gap-4">
              {qr ? (
                <div className="rounded-xl border border-border bg-white p-4 shadow-lg">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={qr}
                    alt="WhatsApp QR Code"
                    width={240}
                    height={240}
                    className="block"
                  />
                </div>
              ) : (
                <div className="flex size-[256px] items-center justify-center rounded-xl border border-dashed border-border bg-muted/40">
                  <Loader2 className="size-8 animate-spin text-muted-foreground" />
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRefreshQr}
                  className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                >
                  <RefreshCw className="size-4" />
                  Refresh Status
                </Button>
              </div>

              <p className="text-xs text-muted-foreground text-center max-w-xs">
                QR codes expire after 60 seconds. If the code appears faded or expired, click{' '}
                <strong>Refresh Status</strong> or restart the connection.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-3">
          {status === 'disconnected' && (
            <Button
              onClick={handleConnect}
              disabled={loading}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {loading ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <Smartphone className="size-4" />
                  Link Phone via QR Code
                </>
              )}
            </Button>
          )}

          {(status === 'qr_ready' || status === 'connecting') && (
            <Button
              variant="outline"
              onClick={handleDisconnect}
              disabled={loading}
              className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
            >
              <WifiOff className="size-4" />
              Cancel
            </Button>
          )}

          {status === 'connected' && (
            <Button
              variant="outline"
              onClick={handleDisconnect}
              disabled={loading}
              className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
            >
              {loading ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Disconnecting...
                </>
              ) : (
                <>
                  <LogOut className="size-4" />
                  Unlink Phone
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Instructions sidebar */}
      <div>
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-foreground text-base flex items-center gap-2">
              <QrCode className="size-4" />
              How to Link Your Phone
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-muted-foreground">
            <div className="space-y-3">
              {[
                {
                  step: 1,
                  title: 'Start the Gateway',
                  desc: 'Make sure the WhatsApp Gateway sidecar is running on your server: npx tsx src/server/whatsapp-gateway/index.ts',
                },
                {
                  step: 2,
                  title: 'Click "Link Phone via QR Code"',
                  desc: 'A QR code will appear on this page within a few seconds.',
                },
                {
                  step: 3,
                  title: 'Open WhatsApp on your phone',
                  desc: 'Tap the three-dot menu (⋮) → Linked Devices → Link a Device.',
                },
                {
                  step: 4,
                  title: 'Scan the QR Code',
                  desc: 'Point your phone camera at the QR code on screen. The phone stays the primary account — messages appear in both the phone and CRM.',
                },
              ].map(({ step, title, desc }) => (
                <div key={step} className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground mt-0.5">
                    {step}
                  </span>
                  <div>
                    <p className="font-medium text-foreground">{title}</p>
                    <p className="text-xs leading-relaxed mt-0.5">{desc}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-amber-700/40 bg-amber-950/20 p-3 text-xs text-amber-200/80">
              <strong className="block text-amber-300 mb-1">⚠️ Important</strong>
              This method connects your existing WhatsApp number (including WhatsApp Business). Your
              messages will still appear on your phone — the CRM receives a copy of all
              conversations.
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
