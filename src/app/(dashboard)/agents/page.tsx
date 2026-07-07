"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Bot,
  Plus,
  MoreVertical,
  Pencil,
  Trash2,
  Loader2,
  Power,
  PowerOff,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// ============================================================
// Types
// ============================================================

interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  model_name: string;
  channels: string[];
  system_prompt: string;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Channel badge colors
// ============================================================

const CHANNEL_COLORS: Record<string, string> = {
  whatsapp: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  facebook: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  instagram: "bg-pink-500/15 text-pink-600 dark:text-pink-400",
  tiktok: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
};

// ============================================================
// Page Component
// ============================================================

export default function AgentsPage() {
  const router = useRouter();
  const { profile } = useAuth();
  const accountId = profile?.account_id;

  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AgentRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ============ FETCH AGENTS ============
  const fetchAgents = useCallback(async () => {
    if (!accountId) return;
    try {
      const res = await fetch(`/api/ai/agents?account_id=${accountId}`);
      if (!res.ok) throw new Error("Failed to fetch agents");
      const data = await res.json();
      setAgents(data.agents ?? []);
    } catch (err) {
      console.error("Failed to load agents:", err);
      toast.error("Failed to load agents");
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  // ============ CREATE AGENT ============
  const handleCreate = async () => {
    if (!newName.trim() || !accountId) return;
    setCreating(true);
    try {
      const res = await fetch("/api/ai/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: accountId,
          name: newName.trim(),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create agent");
      }

      const { agent } = await res.json();
      toast.success(`Agent "${agent.name}" created`);
      setShowCreate(false);
      setNewName("");
      // Navigate to config page for immediate setup
      router.push(`/agents/${agent.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setCreating(false);
    }
  };

  // ============ TOGGLE ACTIVE ============
  const handleToggle = async (agent: AgentRow) => {
    try {
      const res = await fetch(`/api/ai/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !agent.is_active }),
      });
      if (!res.ok) throw new Error("Failed to update agent");

      setAgents((prev) =>
        prev.map((a) =>
          a.id === agent.id ? { ...a, is_active: !a.is_active } : a,
        ),
      );
      toast.success(
        agent.is_active
          ? `"${agent.name}" deactivated`
          : `"${agent.name}" activated`,
      );
    } catch {
      toast.error("Failed to toggle agent");
    }
  };

  // ============ DELETE AGENT ============
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/ai/agents/${deleteTarget.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete agent");

      setAgents((prev) => prev.filter((a) => a.id !== deleteTarget.id));
      toast.success(`Agent "${deleteTarget.name}" deleted`);
      setDeleteTarget(null);
    } catch {
      toast.error("Failed to delete agent");
    } finally {
      setDeleting(false);
    }
  };

  // ============ RENDER ============
  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div>
      {/* ============ HEADER ============ */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            AI Agents
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Build AI agents that automatically respond to customers across
            channels. Each agent has its own personality, knowledge base, and
            skills.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create Agent
        </Button>
      </div>

      {/* ============ EMPTY STATE ============ */}
      {agents.length === 0 && (
        <div className="mt-16 flex flex-col items-center justify-center text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
            <Bot className="h-8 w-8 text-primary" />
          </div>
          <h2 className="mt-4 text-lg font-semibold text-foreground">
            No AI agents yet
          </h2>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">
            Create your first AI agent to start automatically responding to
            WhatsApp messages. Your business will never miss a lead again.
          </p>
          <Button className="mt-6" onClick={() => setShowCreate(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Create Your First Agent
          </Button>
        </div>
      )}

      {/* ============ AGENT CARDS ============ */}
      {agents.length > 0 && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className={cn(
                "group relative rounded-xl border bg-card p-5 transition-all hover:shadow-md",
                agent.is_active
                  ? "border-primary/30 shadow-sm"
                  : "border-border opacity-75",
              )}
            >
              {/* Status dot */}
              <div className="absolute right-4 top-4 flex items-center gap-2">
                <div
                  className={cn(
                    "h-2.5 w-2.5 rounded-full",
                    agent.is_active
                      ? "bg-emerald-500 shadow-sm shadow-emerald-500/30"
                      : "bg-muted-foreground/30",
                  )}
                />
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className="rounded-md p-1 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
                  >
                    <MoreVertical className="h-4 w-4 text-muted-foreground" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => router.push(`/agents/${agent.id}`)}
                    >
                      <Pencil className="mr-2 h-4 w-4" />
                      Configure
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleToggle(agent)}>
                      {agent.is_active ? (
                        <>
                          <PowerOff className="mr-2 h-4 w-4" />
                          Deactivate
                        </>
                      ) : (
                        <>
                          <Power className="mr-2 h-4 w-4" />
                          Activate
                        </>
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => setDeleteTarget(agent)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {/* Agent info */}
              <button
                className="w-full text-left"
                onClick={() => router.push(`/agents/${agent.id}`)}
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                    <Bot className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-semibold text-foreground">
                      {agent.name}
                    </h3>
                    <p className="truncate text-xs text-muted-foreground">
                      {agent.model_name}
                    </p>
                  </div>
                </div>

                {agent.description && (
                  <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">
                    {agent.description}
                  </p>
                )}

                {/* Channels */}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {agent.channels.map((ch) => (
                    <span
                      key={ch}
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                        CHANNEL_COLORS[ch] ?? "bg-muted text-muted-foreground",
                      )}
                    >
                      {ch}
                    </span>
                  ))}
                </div>
              </button>

              {/* Footer — toggle */}
              <div className="mt-4 flex items-center justify-between border-t pt-3">
                <span className="text-xs text-muted-foreground">
                  {agent.is_active ? "Active" : "Inactive"}
                </span>
                <Switch
                  checked={agent.is_active}
                  onCheckedChange={() => handleToggle(agent)}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ============ CREATE DIALOG ============ */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create AI Agent</DialogTitle>
            <DialogDescription>
              Give your agent a name. You&apos;ll configure its personality,
              model, and skills on the next screen.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              placeholder="e.g. Sales Assistant, Support Bot, Booking Agent"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowCreate(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!newName.trim() || creating}
            >
              {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ============ DELETE DIALOG ============ */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={() => setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Agent</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &quot;{deleteTarget?.name}&quot;?
              This will remove the agent and all its configuration. Conversations
              it handled will be preserved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete Agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
