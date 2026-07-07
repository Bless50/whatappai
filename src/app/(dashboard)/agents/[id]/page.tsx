"use client";

import { useCallback, useEffect, useState, useRef } from "react";
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
  Search,
  ChevronDown,
  Zap,
  X,
  Info,
  BarChart3,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { BotPlayground } from "@/components/ai/bot-playground";
import { AgentAnalytics } from "@/components/ai/agent-analytics";

// ============================================================
// Types
// ============================================================

interface AgentDetail {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  system_prompt: string;
  prompt_personality: string | null;
  prompt_goal: string | null;
  prompt_general_info: string | null;
  model_name: string;
  temperature: number;
  max_tokens: number;
  channels: string[];
  takeover_mode: string;
  takeover_timeout_minutes: number;
  approval_mode: boolean;
  has_api_key: boolean;
  created_at: string;
  updated_at: string;
  account_id?: string;
  ai_agent_knowledge_bases?: { knowledge_base_id: string }[];
  ai_agent_skills?: { skill_type: string; is_enabled: boolean; skill_config?: Record<string, unknown> }[];
}

interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  provider: string;
  pricing: {
    prompt: string;
    completion: string;
  };
}

// ============================================================
// Tabs
// ============================================================

type TabKey = "general" | "personality" | "model" | "channels" | "skills" | "analytics" | "playground";

const TABS: { key: TabKey; label: string; icon: React.ElementType }[] = [
  { key: "general", label: "General", icon: Settings },
  { key: "personality", label: "Personality", icon: Sparkles },
  { key: "model", label: "Model & API Key", icon: Brain },
  { key: "channels", label: "Channels", icon: MessageSquare },
  { key: "skills", label: "Skills", icon: Zap },
  { key: "analytics", label: "Analytics", icon: BarChart3 },
  { key: "playground", label: "Playground", icon: Play },
];

const AVAILABLE_SKILLS = [
  { id: "crm_lookup", name: "CRM Lookup", desc: "Allow the AI to search for contact history and details." },
  { id: "book_appointment", name: "Book Appointment", desc: "Allow the AI to check calendar availability and schedule meetings." },
  { id: "create_deal", name: "Create Deal", desc: "Allow the AI to automatically create sales pipeline opportunities." },
  { id: "tag_contact", name: "Tag Contact", desc: "Allow the AI to apply tags to contacts based on the conversation." },
  { id: "update_contact", name: "Update Contact", desc: "Allow the AI to collect and update contact details (like email or company)." },
  { id: "escalate", name: "Escalate", desc: "Allow the AI to pause itself and notify the business owner when human help is needed." },
  { id: "notify_owner", name: "Notify Owner", desc: "Allow the AI to send collected customer information (name, phone, email, interest) to your WhatsApp number." },
];

// ============================================================
// Model Selector Component
// ============================================================

function ModelSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (modelId: string) => void;
}) {
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // ============ FETCH MODELS ============
  useEffect(() => {
    fetch("/api/ai/models")
      .then((res) => res.json())
      .then((data) => {
        if (data.models) setModels(data.models);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // ============ CLOSE ON OUTSIDE CLICK ============
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // ============ FOCUS SEARCH ON OPEN ============
  useEffect(() => {
    if (open && searchRef.current) {
      searchRef.current.focus();
    }
  }, [open]);

  // ============ FILTER MODELS ============
  const filtered = models.filter(
    (m) =>
      m.name.toLowerCase().includes(search.toLowerCase()) ||
      m.id.toLowerCase().includes(search.toLowerCase()) ||
      m.provider.toLowerCase().includes(search.toLowerCase()),
  );

  // ============ GROUP BY PROVIDER ============
  const grouped = filtered.reduce(
    (acc, m) => {
      const provider = m.provider.charAt(0).toUpperCase() + m.provider.slice(1);
      if (!acc[provider]) acc[provider] = [];
      acc[provider].push(m);
      return acc;
    },
    {} as Record<string, OpenRouterModel[]>,
  );

  const selectedModel = models.find((m) => m.id === value);

  // ============ FORMAT PRICE ============
  const formatPrice = (price: string) => {
    const num = parseFloat(price);
    if (num === 0) return "Free";
    if (num < 0.000001) return `$${(num * 1_000_000).toFixed(3)}/M`;
    return `$${(num * 1_000_000).toFixed(2)}/M`;
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* ============ TRIGGER BUTTON ============ */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-sm transition-colors",
          "bg-background hover:bg-muted/50",
          open && "ring-2 ring-primary/30 border-primary/50",
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Zap className="h-4 w-4 shrink-0 text-primary" />
          {loading ? (
            <span className="text-muted-foreground">Loading models...</span>
          ) : selectedModel ? (
            <div className="flex flex-col items-start min-w-0">
              <span className="truncate font-medium">{selectedModel.name}</span>
              <span className="text-[11px] text-muted-foreground truncate">
                {selectedModel.id} • {(selectedModel.context_length / 1000).toFixed(0)}k ctx
                {selectedModel.pricing && (
                  <>
                    {" "}
                    • {formatPrice(selectedModel.pricing.prompt)} input
                  </>
                )}
              </span>
            </div>
          ) : (
            <span className="truncate">
              {value || "Select a model..."}
            </span>
          )}
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {/* ============ DROPDOWN ============ */}
      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 max-h-[360px] overflow-hidden rounded-xl border bg-popover shadow-xl animate-in fade-in-0 zoom-in-95">
          {/* Search */}
          <div className="sticky top-0 border-b bg-popover p-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search 200+ models..."
                className="w-full rounded-md border bg-background py-2 pl-8 pr-8 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Model List */}
          <div className="max-h-[300px] overflow-y-auto p-1">
            {Object.keys(grouped).length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                {loading ? "Loading models..." : "No models found"}
              </div>
            ) : (
              Object.entries(grouped)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([provider, providerModels]) => (
                  <div key={provider}>
                    <div className="sticky top-0 bg-popover px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {provider}
                    </div>
                    {providerModels.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => {
                          onChange(model.id);
                          setOpen(false);
                          setSearch("");
                        }}
                        className={cn(
                          "flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors",
                          "hover:bg-muted/70",
                          value === model.id &&
                            "bg-primary/10 text-primary",
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">
                            {model.name}
                          </div>
                          <div className="truncate text-[11px] text-muted-foreground">
                            {model.id}
                          </div>
                        </div>
                        <div className="ml-3 shrink-0 text-right">
                          <div className="text-[11px] text-muted-foreground">
                            {(model.context_length / 1000).toFixed(0)}k
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {formatPrice(model.pricing.prompt)}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                ))
            )}
          </div>

          {/* Custom model input */}
          <div className="border-t bg-popover p-2">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Or type a custom model ID..."
                className="flex-1 rounded-md border bg-background px-2.5 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.target as HTMLInputElement).value.trim()) {
                    onChange((e.target as HTMLInputElement).value.trim());
                    setOpen(false);
                    setSearch("");
                  }
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

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
  const [approvalMode, setApprovalMode] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [promptPersonality, setPromptPersonality] = useState("");
  const [promptGoal, setPromptGoal] = useState("");
  const [promptGeneralInfo, setPromptGeneralInfo] = useState("");
  const [modelName, setModelName] = useState("");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [apiKey, setApiKey] = useState("");
  const [channels, setChannels] = useState<string[]>(["whatsapp"]);
  const [takeoverMode, setTakeoverMode] = useState("timeout");
  const [takeoverTimeout, setTakeoverTimeout] = useState(120);
  const [kbIds, setKbIds] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [skillConfigs, setSkillConfigs] = useState<Record<string, Record<string, unknown>>>({});
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
      setPromptPersonality(a.prompt_personality ?? "");
      setPromptGoal(a.prompt_goal ?? "");
      setPromptGeneralInfo(a.prompt_general_info ?? "");
      setModelName(a.model_name);
      setTemperature(a.temperature);
      setMaxTokens(a.max_tokens);
      setChannels(a.channels ?? ["whatsapp"]);
      setTakeoverMode(a.takeover_mode ?? "timeout");
      setTakeoverTimeout(a.takeover_timeout_minutes ?? 120);
      setApprovalMode(a.approval_mode ?? false);
      
      // Extract KB IDs
      const kbLinks = a.ai_agent_knowledge_bases ?? [];
      setKbIds(kbLinks.map((link) => link.knowledge_base_id));
      
      // Extract Enabled Skills
      const enabledSkills = (a.ai_agent_skills ?? [])
        .filter((s) => s.is_enabled)
        .map((s) => s.skill_type);
      setSkills(enabledSkills);

      // Extract Skill Configs
      const configs: Record<string, Record<string, unknown>> = {};
      for (const s of a.ai_agent_skills ?? []) {
        if (s.skill_config && Object.keys(s.skill_config).length > 0) {
          configs[s.skill_type] = s.skill_config;
        }
      }
      setSkillConfigs(configs);
      
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
        prompt_personality: promptPersonality,
        prompt_goal: promptGoal,
        prompt_general_info: promptGeneralInfo,
        model_name: modelName,
        temperature,
        max_tokens: maxTokens,
        channels,
        takeover_mode: takeoverMode,
        takeover_timeout_minutes: takeoverTimeout,
        approval_mode: approvalMode,
        knowledge_base_ids: kbIds,
        skills: skills,
        skill_configs: skillConfigs,
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

  // ============ SKILL TOGGLE ============
  const toggleSkill = (sk: string) => {
    setSkills((prev) =>
      prev.includes(sk) ? prev.filter((s) => s !== sk) : [...prev, sk],
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
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <Bot className="h-4 w-4 text-primary" />
            </div>
            <h1 className="text-xl font-bold text-foreground">{name || "Agent"}</h1>
          </div>
          <div
            className={cn(
              "rounded-full px-2.5 py-0.5 text-xs font-medium",
              isActive
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : "bg-muted text-muted-foreground",
            )}
          >
            {isActive ? "Active" : "Inactive"}
          </div>
        </div>
        <Button onClick={handleSave} disabled={saving} className="gap-2">
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Save Changes
        </Button>
      </div>

      {/* ============ TABS ============ */}
      <div className="mt-6 flex gap-1 rounded-lg border bg-muted/30 p-1">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-all",
              activeTab === tab.key
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
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

              <div className="flex items-center justify-between rounded-lg border p-4">
                <div>
                  <p className="font-medium">Human Approval Mode</p>
                  <p className="text-sm text-muted-foreground">
                    When enabled, the AI drafts a response but doesn&apos;t send it.
                    A human must review and approve it from the Inbox.
                  </p>
                </div>
                <Switch checked={approvalMode} onCheckedChange={setApprovalMode} />
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

            <div className="grid gap-6">
              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  Personality & Tone
                </label>
                <p className="mb-2 text-xs text-muted-foreground">
                  How should the AI act? (e.g., friendly, professional, enthusiastic, uses emojis)
                </p>
                <textarea
                  value={promptPersonality}
                  onChange={(e) => setPromptPersonality(e.target.value)}
                  rows={3}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder="Example: You are a friendly, professional sales assistant for [Business Name]. You always use emojis and keep your answers under 3 sentences."
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  Primary Goal
                </label>
                <p className="mb-2 text-xs text-muted-foreground">
                  What is the AI trying to achieve in this conversation?
                </p>
                <textarea
                  value={promptGoal}
                  onChange={(e) => setPromptGoal(e.target.value)}
                  rows={3}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder="Example: Your main goal is to answer questions about our services and naturally guide the user to book a consultation call."
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  General Information
                </label>
                <p className="mb-2 text-xs text-muted-foreground">
                  What facts, prices, or business rules does the AI need to know?
                </p>
                <textarea
                  value={promptGeneralInfo}
                  onChange={(e) => setPromptGeneralInfo(e.target.value)}
                  rows={6}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder={`Example:\n- Teeth cleaning: ₦15,000\n- Dental checkup: ₦10,000\n- Working hours: Mon-Fri 9am-5pm\n- Address: 123 Victoria Island, Lagos`}
                />
              </div>
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

            <div className="space-y-5">
              {/* ============ MODEL SELECTOR ============ */}
              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  AI Model
                </label>
                <ModelSelector value={modelName} onChange={setModelName} />
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

              {/* ============ API KEY ============ */}
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

              {/* ============ TEMPERATURE ============ */}
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

              {/* ============ MAX TOKENS ============ */}
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
                  available: true,
                },
                {
                  id: "instagram",
                  label: "Instagram DMs",
                  desc: "Respond to Instagram direct messages",
                  available: true,
                },
                {
                  id: "tiktok",
                  label: "TikTok",
                  desc: "Respond to TikTok comments and direct messages",
                  available: true,
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

        {/* SKILLS TAB */}
        {activeTab === "skills" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold">Agent Skills</h2>
              <p className="text-sm text-muted-foreground">
                Give your AI superpowers. Turn on the specific actions you want this agent to be able to perform autonomously.
              </p>
            </div>

            <div className="grid gap-4">
              {AVAILABLE_SKILLS.map((skill) => (
                <div
                  key={skill.id}
                  className="rounded-lg border p-4 shadow-sm space-y-3"
                >
                  <div className="flex items-start justify-between">
                    <div className="mr-6">
                      <p className="font-medium">{skill.name}</p>
                      <p className="text-sm text-muted-foreground">{skill.desc}</p>
                    </div>
                    <Switch
                      checked={skills.includes(skill.id)}
                      onCheckedChange={() => toggleSkill(skill.id)}
                    />
                  </div>
                  {/* Notify Owner — phone number config */}
                  {skill.id === "notify_owner" && skills.includes("notify_owner") && (
                    <div className="pt-2 border-t">
                      <label className="block text-xs font-medium text-muted-foreground mb-1">
                        Your WhatsApp Number (receives notifications)
                      </label>
                      <Input
                        type="tel"
                        placeholder="+234 xxx xxxx xxxx"
                        value={(skillConfigs.notify_owner?.notify_phone as string) ?? ""}
                        onChange={(e) =>
                          setSkillConfigs((prev) => ({
                            ...prev,
                            notify_owner: {
                              ...prev.notify_owner,
                              notify_phone: e.target.value,
                            },
                          }))
                        }
                        className="max-w-xs"
                      />
                      <p className="text-[11px] text-muted-foreground mt-1">
                        The AI will send collected customer info to this number via WhatsApp.
                      </p>
                    </div>
                  )}
                </div>
              ))}
            </div>
            
            <div className="rounded-md bg-blue-50 p-4 border border-blue-200 mt-6">
              <div className="flex gap-3">
                <Info className="h-5 w-5 text-blue-500 shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-sm font-semibold text-blue-800 mb-1">How Skills Work</h3>
                  <p className="text-xs text-blue-700 leading-relaxed">
                    When enabled, the AI uses its judgment to trigger these skills at the right moment. For example, if &apos;Book Appointment&apos; is enabled, the AI will check your default CRM calendar when a customer asks for a meeting. If &apos;Create Deal&apos; is enabled, it will automatically drop leads into the first stage of your default sales pipeline.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ANALYTICS TAB */}
        {activeTab === "analytics" && (
          <div className="pt-2">
            <AgentAnalytics agentId={params.id as string} />
          </div>
        )}

        {/* PLAYGROUND TAB */}
        {activeTab === "playground" && (
          <div className="pt-2">
            <BotPlayground agentId={agentId} accountId={agent?.account_id} />
          </div>
        )}
      </div>
    </div>
  );
}
