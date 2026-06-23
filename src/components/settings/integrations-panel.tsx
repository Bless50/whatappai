"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import { CalendarDays, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

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

  useEffect(() => {
    if (!accountId) return;
    fetchIntegrations();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const fetchIntegrations = async () => {
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
  };

  const handleConnectGoogle = () => {
    if (!accountId) return;
    const redirectUri = window.location.href; // return back to this page
    window.location.href = `/api/integrations/google/auth?account_id=${accountId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
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

  // Check URL for success/error from OAuth callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("success")) {
      toast.success("Google Calendar connected successfully!");
      // clean up URL
      window.history.replaceState({}, document.title, window.location.pathname + "?tab=integrations");
    } else if (params.get("error")) {
      toast.error(`Connection failed: ${params.get("error")}`);
      window.history.replaceState({}, document.title, window.location.pathname + "?tab=integrations");
    }
  }, []);

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Integrations</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect external apps to give your AI superpowers.
        </p>
      </div>

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
                <p className="font-medium">Google Calendar</p>
                <p className="text-sm text-muted-foreground">Sync appointments with Google</p>
              </div>
            </div>
            
            <Button onClick={handleConnectGoogle} variant="outline" className="shrink-0 gap-2">
              <Plus className="w-4 h-4" />
              Connect
            </Button>
          </div>

          <div className="mt-8">
            <h4 className="text-sm font-medium mb-3">Connected Accounts</h4>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading...
              </div>
            ) : integrations.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No accounts connected yet.</p>
            ) : (
              <div className="space-y-3">
                {integrations.map((integration) => (
                  <div key={integration.id} className="flex items-center justify-between py-2 px-3 bg-muted/30 rounded-md border text-sm">
                    <div className="flex items-center gap-3">
                      <CalendarDays className="w-4 h-4 text-muted-foreground" />
                      <span className="font-medium">{integration.provider_account_id}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary uppercase">
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
      </div>
    </div>
  );
}
