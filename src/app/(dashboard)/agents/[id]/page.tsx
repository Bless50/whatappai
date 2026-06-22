"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { toast } from "sonner";
import {
  Bot,
  ArrowLeft,
  Save,
  Loader2,
  Sparkles,
  Settings,
  Brain,
  MessageSquare,
  Key,
  Play,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { BotPlayground } from "@/components/ai/bot-playground";

// ============================================================
// Types
// ============================================================

interface AgentDetail {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  system_prompt: string;
  model_name: string;
  temperature: number;
  max_tokens: number;
  channels: string[];
  takeover_mode: string;
  takeover_timeout_minutes: number;
  has_api_key: boolean;
  created_at: string;
  updated_at: string;
  account_id?: string;
  ai_agent_knowledge_bases?: { knowledge_base_id: string }[];
}

// ============================================================
// Popular models on OpenRouter
// ============================================================

const POPULAR_MODELS = [
  { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "Google" },
  { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "Google" },
  { value: "deepseek/deepseek-chat", label: "DeepSeek V3", provider: "DeepSeek" },
  { value: "deepseek/deepseek-r1", label: "DeepSeek R1", provider: "DeepSeek" },
  { value: "openai/gpt-4o-mini", label: "GPT-4o Mini", provider: "OpenAI" },
  { value: "openai/gpt-4o", label: "GPT-4o", provider: "OpenAI" },
  { value: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", provider: "Anthropic" },
  { value: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B", provider: "Meta" },
];

// ============================================================
// Tabs
// ============================================================

type TabKey = "general" | "personality" | "model" | "channels" | "playground";

const TABS: { key: TabKey; label: string; icon: React.ElementType }[] = [
  { key: "general", label: "General", icon: Settings },
  { key: "personality", label: "Personality", icon: Sparkles },
  { key: "model", label: "Model & API Key", icon: Brain },
  { key: "channels", label: "Channels", icon: MessageSquare },
  { key: "playground", label: "Playground", icon: Play },
];

// ============================================================
// Page Component
// ============================================================

export default function AgentConfigPage() {
  const router = useRouter();
  const params = useParams();
  const agentId = params.id as string;

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("general");

  // Form state — mirrors the agent config
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isActive, setIsActive] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [modelName, setModelName] = useState("");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [apiKey, setApiKey] = useState("");
  const [channels, setChannels] = useState<string[]>(["whatsapp"]);
  const [takeoverMode, setTakeoverMode] = useState("timeout");
  const [takeoverTimeout, setTakeoverTimeout] = useState(120);
  const [kbIds, setKbIds] = useState<string[]>([]);
  const [availableKbs, setAvailableKbs] = useState<{id: string, name: string}[]>([]);

  // ============ FETCH AGENT ============
  const fetchAgent = useCallback(async () => {
    try {
      const res = await fetch(`/api/ai/agents/${agentId}`);
      if (!res.ok) throw new Error("Agent not found");
      const data = await res.json();
      const a = data.agent as AgentDetail;
      setAgent(a);
      // Populate form
      setName(a.name);
      setDescription(a.description ?? "");
      setIsActive(a.is_active);
      setSystemPrompt(a.system_prompt);
      setModelName(a.model_name);
      setTemperature(a.temperature);
      setMaxTokens(a.max_tokens);
      setChannels(a.channels ?? ["whatsapp"]);
      setTakeoverMode(a.takeover_mode ?? "timeout");
      setTakeoverTimeout(a.takeover_timeout_minutes ?? 120);
      
      // Extract KB IDs
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const kbLinks = (a as any).ai_agent_knowledge_bases ?? [];
      setKbIds(kbLinks.map((link: any) => link.knowledge_base_id));
      
      // Fetch available KBs for this account
      if (a.account_id) {
        fetch(`/api/ai/knowledge?account_id=${a.account_id}`)
          .then(res => res.json())
          .then(data => {
            if (data.knowledge_bases) setAvailableKbs(data.knowledge_bases);
          })
          .catch(console.error);
      }
    } catch (err) {
      console.error("Failed to load agent:", err);
      toast.error("Agent not found");
      router.push("/agents");
    } finally {
      setLoading(false);
    }
  }, [agentId, router]);

  useEffect(() => {
    fetchAgent();
  }, [fetchAgent]);

  // ============ SAVE ============
  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name,
        description: description || null,
        is_active: isActive,
        system_prompt: systemPrompt,
        model_name: modelName,
        temperature,
        max_tokens: maxTokens,
        channels,
        takeover_mode: takeoverMode,
        takeover_timeout_minutes: takeoverTimeout,
        knowledge_base_ids: kbIds,
      };

      // Only send API key if user entered a new one
      if (apiKey.trim()) {
        body.openrouter_api_key = apiKey.trim();
      }

      const res = await fetch(`/api/ai/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save");
      }

      toast.success("Agent saved");
      setApiKey(""); // Clear the key field after save
      fetchAgent(); // Refresh
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  // ============ CHANNEL TOGGLE ============
  const toggleChannel = (ch: string) => {
    setChannels((prev) =>
      prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch],
    );
  };

  // ============ LOADING ============
  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!agent) return null;

  return (
    <div className="mx-auto max-w-4xl">
      {/* ============ TOP BAR ============ */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push("/agents")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-bold text-foreground">{name || "Agent"}</h1>
          </div>
          <div
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium",
              isActive
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : "bg-muted text-muted-foreground",
            )}
          >
            {isActive ? "Active" : "Inactive"}
          </div>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Save Changes
        </Button>
      </div>

      {/* ============ TABS ============ */}
      <div className="mt-6 flex gap-1 rounded-lg border bg-muted/50 p-1">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-all",
              activeTab === tab.key
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* ============ TAB CONTENT ============ */}
      <div className="mt-6 rounded-xl border bg-card p-6">
        {/* GENERAL TAB */}
        {activeTab === "general" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold">General Settings</h2>
              <p className="text-sm text-muted-foreground">
                Basic configuration for your AI agent.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  Agent Name
                </label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Sales Assistant"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  Description
                </label>
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Brief description of what this agent does"
                />
              </div>

              <div className="flex items-center justify-between rounded-lg border p-4">
                <div>
                  <p className="font-medium">Active</p>
                  <p className="text-sm text-muted-foreground">
                    When active, this agent will automatically respond to
                    incoming messages on its assigned channels.
                  </p>
                </div>
                <Switch checked={isActive} onCheckedChange={setIsActive} />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  Human Takeover Mode
                </label>
                <select
                  value={takeoverMode}
                  onChange={(e) => setTakeoverMode(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                >
                  <option value="timeout">
                    Timeout — AI resumes after {takeoverTimeout} minutes
                  </option>
                  <option value="manual">
                    Manual — AI stays paused until &quot;Hand Back&quot; is clicked
                  </option>
                  <option value="on_close">
                    On Close — AI resumes when conversation is closed
                  </option>
                </select>
              </div>

              {takeoverMode === "timeout" && (
                <div>
                  <label className="mb-1.5 block text-sm font-medium">
                    Timeout (minutes)
                  </label>
                  <Input
                    type="number"
                    value={takeoverTimeout}
                    onChange={(e) => setTakeoverTimeout(Number(e.target.value))}
                    min={5}
                    max={1440}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {/* PERSONALITY TAB */}
        {activeTab === "personality" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold">Agent Personality</h2>
              <p className="text-sm text-muted-foreground">
                Define how your agent behaves, its tone of voice, and what it
                knows. This is the system prompt sent to the AI model.
              </p>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium">
                System Prompt
              </label>
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={12}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder={`Example:\nYou are a friendly sales assistant for [Business Name], a dental clinic in Lagos.\n\nYour job:\n- Answer questions about our services and pricing\n- Help customers book appointments\n- Qualify leads by asking about their needs\n- Be warm, professional, and concise\n\nOur services:\n- Teeth cleaning: ₦15,000\n- Dental checkup: ₦10,000\n- Root canal: ₦50,000-₦80,000\n\nWorking hours: Mon-Fri 9am-5pm, Sat 9am-1pm\nAddress: 123 Victoria Island, Lagos`}
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                Tip: Include your business name, services, pricing, working
                hours, and any rules the agent should follow.
              </p>
            </div>

            <div className="space-y-4 pt-4 border-t">
              <div>
                <h3 className="text-sm font-medium">Knowledge Bases</h3>
                <p className="text-xs text-muted-foreground mb-3">
                  Select which knowledge bases this agent can search for answers.
                </p>
                {availableKbs.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">No knowledge bases created yet.</p>
                ) : (
                  <div className="grid gap-3">
                    {availableKbs.map((kb) => (
                      <label key={kb.id} className="flex items-center gap-3 rounded-lg border p-3 hover:bg-muted/50 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={kbIds.includes(kb.id)}
                          onChange={(e) => {
                            if (e.target.checked) setKbIds([...kbIds, kb.id]);
                            else setKbIds(kbIds.filter(id => id !== kb.id));
                          }}
                          className="h-4 w-4 rounded border-gray-300 text-brand-green focus:ring-brand-green"
                        />
                        <span className="font-medium text-sm">{kb.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* MODEL TAB */}
        {activeTab === "model" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold">Model & API Key</h2>
              <p className="text-sm text-muted-foreground">
                Choose which AI model powers your agent and provide your
                OpenRouter API key.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  AI Model
                </label>
                <select
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                >
                  {POPULAR_MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label} ({m.provider})
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Powered by{" "}
                  <a
                    href="https://openrouter.ai/models"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline"
                  >
                    OpenRouter
                  </a>{" "}
                  — access 200+ models with one API key.
                </p>
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  OpenRouter API Key
                </label>
                <div className="relative">
                  <Key className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={
                      agent.has_api_key
                        ? "••••••••••••• (key saved — enter new to replace)"
                        : "sk-or-v1-..."
                    }
                    className="pl-10"
                  />
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Get your key at{" "}
                  <a
                    href="https://openrouter.ai/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline"
                  >
                    openrouter.ai/keys
                  </a>
                  . Your key is encrypted and stored securely.
                </p>
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  Temperature: {temperature.toFixed(1)}
                </label>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                  className="w-full accent-primary"
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>More Focused (0)</span>
                  <span>More Creative (2)</span>
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  Max Response Length (tokens)
                </label>
                <Input
                  type="number"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(Number(e.target.value))}
                  min={100}
                  max={4096}
                />
              </div>
            </div>
          </div>
        )}

        {/* CHANNELS TAB */}
        {activeTab === "channels" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold">Channel Assignment</h2>
              <p className="text-sm text-muted-foreground">
                Select which channels this agent monitors and responds on.
              </p>
            </div>

            <div className="space-y-3">
              {[
                {
                  id: "whatsapp",
                  label: "WhatsApp",
                  desc: "Respond to WhatsApp messages automatically",
                  available: true,
                },
                {
                  id: "facebook",
                  label: "Facebook Messenger",
                  desc: "Respond to Facebook messages and comments",
                  available: false,
                },
                {
                  id: "instagram",
                  label: "Instagram DMs",
                  desc: "Respond to Instagram direct messages",
                  available: false,
                },
              ].map((ch) => (
                <div
                  key={ch.id}
                  className={cn(
                    "flex items-center justify-between rounded-lg border p-4",
                    !ch.available && "opacity-50",
                  )}
                >
                  <div>
                    <p className="font-medium">
                      {ch.label}
                      {!ch.available && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          (Coming Soon)
                        </span>
                      )}
                    </p>
                    <p className="text-sm text-muted-foreground">{ch.desc}</p>
                  </div>
                  <Switch
                    checked={channels.includes(ch.id)}
                    onCheckedChange={() => toggleChannel(ch.id)}
                    disabled={!ch.available}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* PLAYGROUND TAB */}
        {activeTab === "playground" && (
          <div className="pt-2">
            <BotPlayground agentId={agentId} />
          </div>
        )}
      </div>
    </div>
  );
}
