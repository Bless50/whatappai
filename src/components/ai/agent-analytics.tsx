"use client";

import { useEffect, useState } from "react";
import { Loader2, Users, Clock, CalendarCheck, MessageSquare, Coins, Zap } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface AnalyticsMetrics {
  totalMessages: number;
  totalTokens: number;
  totalCost: number;
  peopleReached: number;
  appointmentsBooked: number;
  timeSavedMinutes: number;
}

interface LogEntry {
  id: string;
  created_at: string;
  model_used: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  total_cost_usd: number;
}

interface AnalyticsData {
  metrics: AnalyticsMetrics;
  recentLogs: LogEntry[];
}

export function AgentAnalytics({ agentId }: { agentId: string }) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/ai/agents/${agentId}/analytics`)
      .then((res) => res.json())
      .then((d) => setData(d))
      .catch((err) => console.error("Failed to load analytics", err))
      .finally(() => setLoading(false));
  }, [agentId]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        No analytics data available.
      </div>
    );
  }

  const { metrics, recentLogs } = data;

  // Format time saved
  const formatTimeSaved = (minutes: number) => {
    if (minutes < 60) return `${minutes} mins`;
    const hours = (minutes / 60).toFixed(1);
    return `${hours} hrs`;
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Agent Analytics</h2>
        <p className="text-sm text-muted-foreground">
          Monitor your AI&apos;s performance, cost, and the value it provides to your business.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Time Saved</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatTimeSaved(metrics.timeSavedMinutes)}</div>
            <p className="text-xs text-muted-foreground mt-1">Based on 2 mins/msg</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">People Reached</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{metrics.peopleReached}</div>
            <p className="text-xs text-muted-foreground mt-1">Unique contacts</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Appointments Booked</CardTitle>
            <CalendarCheck className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{metrics.appointmentsBooked}</div>
            <p className="text-xs text-muted-foreground mt-1">Successfully scheduled</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Messages</CardTitle>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{metrics.totalMessages}</div>
            <p className="text-xs text-muted-foreground mt-1">Sent by AI</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Tokens</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{metrics.totalTokens.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">Prompt & completion</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Cost</CardTitle>
            <Coins className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${metrics.totalCost.toFixed(4)}</div>
            <p className="text-xs text-muted-foreground mt-1">USD</p>
          </CardContent>
        </Card>
      </div>

      <div className="mt-8">
        <h3 className="text-lg font-semibold mb-4">Recent Logs</h3>
        <div className="rounded-md border bg-card">
          <div className="relative w-full overflow-auto">
            <table className="w-full caption-bottom text-sm">
              <thead className="[&_tr]:border-b bg-muted/50">
                <tr className="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted">
                  <th className="h-10 px-4 text-left align-middle font-medium text-muted-foreground">Time</th>
                  <th className="h-10 px-4 text-left align-middle font-medium text-muted-foreground">Model</th>
                  <th className="h-10 px-4 text-left align-middle font-medium text-muted-foreground">Latency</th>
                  <th className="h-10 px-4 text-left align-middle font-medium text-muted-foreground">Tokens</th>
                  <th className="h-10 px-4 text-left align-middle font-medium text-muted-foreground">Cost</th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child]:border-0">
                {recentLogs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-4 text-center text-muted-foreground">No logs yet.</td>
                  </tr>
                ) : (
                  recentLogs.map((log) => (
                    <tr key={log.id} className="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted">
                      <td className="p-4 align-middle whitespace-nowrap text-muted-foreground">
                        {new Date(log.created_at).toLocaleString(undefined, { 
                          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' 
                        })}
                      </td>
                      <td className="p-4 align-middle font-medium truncate max-w-[150px]" title={log.model_used}>
                        {log.model_used}
                      </td>
                      <td className="p-4 align-middle">
                        {log.latency_ms}ms
                      </td>
                      <td className="p-4 align-middle">
                        <span className="text-muted-foreground text-xs">{log.prompt_tokens} + {log.completion_tokens}</span>
                        <br/>
                        {log.prompt_tokens + log.completion_tokens}
                      </td>
                      <td className="p-4 align-middle">
                        ${log.total_cost_usd.toFixed(6)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
