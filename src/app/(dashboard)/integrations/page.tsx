"use client";

import { IntegrationsPanel } from "@/components/settings/integrations-panel";

export default function IntegrationsPage() {
  return (
    <div className="space-y-6">
      <div className="border-b pb-4">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Integrations
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect external calendars, messaging channels, and services to give your AI agent superpowers.
        </p>
      </div>

      <div className="min-w-0">
        <IntegrationsPanel />
      </div>
    </div>
  );
}
