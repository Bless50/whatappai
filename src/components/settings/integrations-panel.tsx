"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import { CalendarDays, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Brand icons were removed in Lucide v1, so we define custom SVG wrappers for them.
interface IconProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
}

const Facebook = ({ className, size = 24, ...props }: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
  </svg>
);

const Instagram = ({ className, size = 24, ...props }: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
    <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
    <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
  </svg>
);

const TikTok = ({ className, size = 24, ...props }: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    {...props}
  >
    <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.17-2.89-.74-3.94-1.78-.22-.22-.41-.47-.59-.73v7.02c0 3.82-3.13 7.02-7.01 7.02-3.69-.02-6.73-2.91-7-6.59-.44-3.91 2.62-7.46 6.55-7.46 1.12.01 2.19.3 3.11.85V0l.13.02z" />
  </svg>
);

interface Integration {
  id: string;
  provider: string;
  provider_account_id: string;
  created_at: string;
}

export function IntegrationsPanel() {
  const { profile } = useAuth();
  const accountId = profile?.account_id;
  
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);

  // Facebook dialog states
  const [isFacebookOpen, setIsFacebookOpen] = useState(false);
  const [fbPageId, setFbPageId] = useState("");
  const [fbToken, setFbToken] = useState("");

  // Instagram dialog states
  const [isInstagramOpen, setIsInstagramOpen] = useState(false);
  const [igAccountId, setIgAccountId] = useState("");
  const [igToken, setIgToken] = useState("");

  // TikTok dialog states
  const [isTikTokOpen, setIsTikTokOpen] = useState(false);
  const [tiktokAccountId, setTiktokAccountId] = useState("");
  const [tiktokToken, setTiktokToken] = useState("");

  async function fetchIntegrations() {
    try {
      const res = await fetch(`/api/integrations?account_id=${accountId}`);
      const data = await res.json();
      if (data.integrations) {
        setIntegrations(data.integrations);
      }
    } catch (err) {
      console.error(err);
      toast.error("Failed to load integrations");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!accountId) return;
    fetchIntegrations();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const handleConnectGoogle = () => {
    if (!accountId) return;
    const redirectUri = window.location.href;
    window.location.href = `/api/integrations/google/auth?account_id=${accountId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  };

  const handleConnectFacebook = async () => {
    if (!fbPageId.trim() || !fbToken.trim()) {
      toast.error("Please enter both Page ID and Access Token");
      return;
    }
    setConnecting(true);
    try {
      const res = await fetch('/api/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId,
          provider: 'facebook',
          provider_account_id: fbPageId.trim(),
          access_token: fbToken.trim(),
        }),
      });

      if (!res.ok) throw new Error("Failed to connect");
      toast.success("Facebook Page connected successfully!");
      setIsFacebookOpen(false);
      setFbPageId("");
      setFbToken("");
      fetchIntegrations();
    } catch (err) {
      toast.error("Failed to connect Facebook Page");
    } finally {
      setConnecting(false);
    }
  };

  const handleConnectInstagram = async () => {
    if (!igAccountId.trim() || !igToken.trim()) {
      toast.error("Please enter both Business Account ID and Page Access Token");
      return;
    }
    setConnecting(true);
    try {
      const res = await fetch('/api/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId,
          provider: 'instagram',
          provider_account_id: igAccountId.trim(),
          access_token: igToken.trim(),
        }),
      });

      if (!res.ok) throw new Error("Failed to connect");
      toast.success("Instagram Business connected successfully!");
      setIsInstagramOpen(false);
      setIgAccountId("");
      setIgToken("");
      fetchIntegrations();
    } catch (err) {
      toast.error("Failed to connect Instagram Business account");
    } finally {
      setConnecting(false);
    }
  };

  const handleConnectTikTok = async () => {
    if (!tiktokAccountId.trim() || !tiktokToken.trim()) {
      toast.error("Please enter both TikTok Business Account ID and Access Token");
      return;
    }
    setConnecting(true);
    try {
      const res = await fetch('/api/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId,
          provider: 'tiktok',
          provider_account_id: tiktokAccountId.trim(),
          access_token: tiktokToken.trim(),
        }),
      });

      if (!res.ok) throw new Error("Failed to connect");
      toast.success("TikTok Business connected successfully!");
      setIsTikTokOpen(false);
      setTiktokAccountId("");
      setTiktokToken("");
      fetchIntegrations();
    } catch (err) {
      toast.error("Failed to connect TikTok Business account");
    } finally {
      setConnecting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to disconnect this account?")) return;
    
    try {
      const res = await fetch(`/api/integrations?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error("Failed to delete");
      toast.success("Integration disconnected");
      fetchIntegrations();
    } catch (err) {
      console.error(err);
      toast.error("Failed to disconnect integration");
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("success")) {
      toast.success("Google Calendar connected successfully!");
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (params.get("error")) {
      toast.error(`Connection failed: ${params.get("error")}`);
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Google Calendar */}
      <div className="rounded-xl border bg-card text-card-foreground shadow-sm">
        <div className="flex flex-col space-y-1.5 p-6 border-b">
          <h3 className="text-lg font-semibold leading-none tracking-tight">Calendar Integrations</h3>
          <p className="text-sm text-muted-foreground">
            Allow your AI to check your real availability and book appointments directly to your calendar.
          </p>
        </div>
        <div className="p-6">
          <div className="flex items-center justify-between border rounded-lg p-4 bg-muted/20">
            <div className="flex items-center gap-4">
              <div className="bg-white p-2 rounded-md border shadow-sm">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="32px" height="32px">
                  <path fill="#fbbc05" d="M10.5 13.5h5.5v21h-5.5z"/>
                  <path fill="#ea4335" d="M10.5 13.5l5.5 5.5-5.5 5.5z"/>
                  <path fill="#34a853" d="M10.5 23.5l5.5-5.5-5.5-5.5z"/>
                  <path fill="#4285f4" d="M10.5 13.5h5.5l-5.5 10z"/>
                  <path fill="#4285f4" d="M31.5 34.5v-21h5.5v21z"/>
                  <path fill="#34a853" d="M31.5 13.5l5.5 5.5-5.5 5.5z"/>
                  <path fill="#ea4335" d="M31.5 23.5l5.5-5.5-5.5-5.5z"/>
                  <path fill="#fbbc05" d="M31.5 13.5h5.5l-5.5 10z"/>
                  <path fill="#34a853" d="M10.5 13.5h26.5v5.5H10.5z"/>
                  <path fill="#ea4335" d="M10.5 29.5h26.5v5.5H10.5z"/>
                </svg>
              </div>
              <div>
                <p className="font-medium text-sm">Google Calendar</p>
                <p className="text-xs text-muted-foreground">Sync appointments with Google</p>
              </div>
            </div>
            
            <Button onClick={handleConnectGoogle} variant="outline" className="shrink-0 gap-2 text-xs">
              <Plus className="w-4 h-4" />
              Connect
            </Button>
          </div>
        </div>
      </div>

      {/* Social Messaging Integrations */}
      <div className="rounded-xl border bg-card text-card-foreground shadow-sm">
        <div className="flex flex-col space-y-1.5 p-6 border-b">
          <h3 className="text-lg font-semibold leading-none tracking-tight">Social Messaging Channels</h3>
          <p className="text-sm text-muted-foreground">
            Connect Facebook and Instagram to respond to comments and private direct messages (DMs).
          </p>
        </div>
        <div className="p-6 space-y-4">
          {/* Facebook */}
          <div className="flex items-center justify-between border rounded-lg p-4 bg-muted/20">
            <div className="flex items-center gap-4">
              <div className="bg-blue-600 text-white p-2 rounded-md border shadow-sm flex items-center justify-center">
                <Facebook className="w-8 h-8 fill-white text-blue-600" />
              </div>
              <div>
                <p className="font-medium text-sm">Facebook Page</p>
                <p className="text-xs text-muted-foreground">Reply to Page DMs and post/ads comments</p>
              </div>
            </div>
            
            <Button onClick={() => setIsFacebookOpen(true)} variant="outline" className="shrink-0 gap-2 text-xs">
              <Plus className="w-4 h-4" />
              Connect Page
            </Button>
          </div>

          {/* Instagram */}
          <div className="flex items-center justify-between border rounded-lg p-4 bg-muted/20">
            <div className="flex items-center gap-4">
              <div className="bg-gradient-to-tr from-yellow-500 via-red-500 to-purple-500 text-white p-2.5 rounded-md border shadow-sm flex items-center justify-center">
                <Instagram className="w-7 h-7" />
              </div>
              <div>
                <p className="font-medium text-sm">Instagram Business</p>
                <p className="text-xs text-muted-foreground">Reply to direct messages (DMs) and post comments</p>
              </div>
            </div>
            
            <Button onClick={() => setIsInstagramOpen(true)} variant="outline" className="shrink-0 gap-2 text-xs">
              <Plus className="w-4 h-4" />
              Connect Instagram
            </Button>
          </div>

          {/* TikTok */}
          <div className="flex items-center justify-between border rounded-lg p-4 bg-muted/20">
            <div className="flex items-center gap-4">
              <div className="bg-black text-white p-2.5 rounded-md border shadow-sm flex items-center justify-center">
                <TikTok className="w-7 h-7 fill-white" />
              </div>
              <div>
                <p className="font-medium text-sm">TikTok Business</p>
                <p className="text-xs text-muted-foreground">Reply to direct messages (DMs) and video comments</p>
              </div>
            </div>
            
            <Button onClick={() => setIsTikTokOpen(true)} variant="outline" className="shrink-0 gap-2 text-xs">
              <Plus className="w-4 h-4" />
              Connect TikTok
            </Button>
          </div>
        </div>
      </div>

      {/* Connected Accounts List */}
      <div className="rounded-xl border bg-card text-card-foreground shadow-sm">
        <div className="flex flex-col space-y-1.5 p-6 border-b">
          <h3 className="text-lg font-semibold leading-none tracking-tight">Connected Accounts</h3>
          <p className="text-sm text-muted-foreground">Manage active credential syncs.</p>
        </div>
        <div className="p-6">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading integrations...
            </div>
          ) : integrations.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No integrations connected yet.</p>
          ) : (
            <div className="space-y-3">
              {integrations.map((integration) => (
                <div key={integration.id} className="flex items-center justify-between py-2 px-3 bg-muted/30 rounded-md border text-sm">
                  <div className="flex items-center gap-3">
                    {integration.provider === "google" ? (
                      <CalendarDays className="w-4 h-4 text-muted-foreground" />
                    ) : integration.provider === "facebook" ? (
                      <Facebook className="w-4 h-4 text-blue-600 fill-blue-600" />
                    ) : integration.provider === "tiktok" ? (
                      <TikTok className="w-4 h-4 text-black fill-black dark:text-white dark:fill-white" />
                    ) : (
                      <Instagram className="w-4 h-4 text-pink-600" />
                    )}
                    <span className="font-mono text-xs">{integration.provider_account_id}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-bold uppercase font-sans">
                      {integration.provider}
                    </span>
                  </div>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => handleDelete(integration.id)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Facebook Connect Dialog */}
      <Dialog open={isFacebookOpen} onOpenChange={setIsFacebookOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Facebook className="w-5 h-5 fill-blue-600 text-blue-600" /> Connect Facebook Page
            </DialogTitle>
            <DialogDescription>
              Enter your Facebook Page ID and Page Access Token. You can generate these from your Meta for Developers dashboard.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="fbPageId" className="text-xs">Facebook Page ID</Label>
              <Input
                id="fbPageId"
                placeholder="E.g. 102948271049"
                value={fbPageId}
                onChange={(e) => setFbPageId(e.target.value)}
                className="text-xs"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="fbToken" className="text-xs">Page Access Token</Label>
              <Input
                id="fbToken"
                type="password"
                placeholder="EAA..."
                value={fbToken}
                onChange={(e) => setFbToken(e.target.value)}
                className="text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="text-xs" onClick={() => setIsFacebookOpen(false)} disabled={connecting}>
              Cancel
            </Button>
            <Button className="text-xs" onClick={handleConnectFacebook} disabled={connecting}>
              {connecting && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
              Connect Page
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Instagram Connect Dialog */}
      <Dialog open={isInstagramOpen} onOpenChange={setIsInstagramOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Instagram className="w-5 h-5 text-pink-600" /> Connect Instagram Business
            </DialogTitle>
            <DialogDescription>
              Enter your Instagram Business Account ID and Meta Page Access Token (which has permissions for the linked Instagram account).
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="igAccountId" className="text-xs">Instagram Account ID</Label>
              <Input
                id="igAccountId"
                placeholder="E.g. 178414029482710"
                value={igAccountId}
                onChange={(e) => setIgAccountId(e.target.value)}
                className="text-xs"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="igToken" className="text-xs">Page Access Token</Label>
              <Input
                id="igToken"
                type="password"
                placeholder="EAA..."
                value={igToken}
                onChange={(e) => setIgToken(e.target.value)}
                className="text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="text-xs" onClick={() => setIsInstagramOpen(false)} disabled={connecting}>
              Cancel
            </Button>
            <Button className="text-xs" onClick={handleConnectInstagram} disabled={connecting}>
              {connecting && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
              Connect Account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* TikTok Connect Dialog */}
      <Dialog open={isTikTokOpen} onOpenChange={setIsTikTokOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TikTok className="w-5 h-5 text-black fill-black dark:text-white dark:fill-white" /> Connect TikTok Business
            </DialogTitle>
            <DialogDescription>
              Enter your TikTok Business Account ID and Developer Access Token. You can generate these from your TikTok for Developers dashboard.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="tiktokAccountId" className="text-xs">TikTok Account ID / Username</Label>
              <Input
                id="tiktokAccountId"
                placeholder="E.g. @mybusiness"
                value={tiktokAccountId}
                onChange={(e) => setTiktokAccountId(e.target.value)}
                className="text-xs"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tiktokToken" className="text-xs">Access Token</Label>
              <Input
                id="tiktokToken"
                type="password"
                placeholder="act.tks..."
                value={tiktokToken}
                onChange={(e) => setTiktokToken(e.target.value)}
                className="text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="text-xs" onClick={() => setIsTikTokOpen(false)} disabled={connecting}>
              Cancel
            </Button>
            <Button className="text-xs" onClick={handleConnectTikTok} disabled={connecting}>
              {connecting && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
              Connect Account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
