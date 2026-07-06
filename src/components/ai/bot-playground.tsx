"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Bot, Info, Brain } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AIAgent } from "@/lib/ai/types";

interface MessageSource {
  source_name?: string;
  source_type?: string;
}

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  sources?: MessageSource[];
}

export function BotPlayground({ 
  agentId, 
  accountId 
}: { 
  agentId: string; 
  accountId?: string; 
}) {
  const [agents, setAgents] = useState<AIAgent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(agentId);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", content: "Hi! I am ready to be tested. Say something!" }
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load all agents for this account
  useEffect(() => {
    let active = true;
    async function loadAgents() {
      try {
        let currentAccountId = accountId;
        if (!currentAccountId) {
          const res = await fetch(`/api/ai/agents/${agentId}`);
          if (res.ok && active) {
            const data = await res.json();
            currentAccountId = data.agent?.account_id;
          }
        }
        
        if (currentAccountId && active) {
          const res = await fetch(`/api/ai/agents?account_id=${currentAccountId}`);
          if (res.ok && active) {
            const data = await res.json();
            setAgents(data.agents || []);
          }
        }
      } catch (err) {
        console.error("Failed to load agents in playground:", err);
      } finally {
        if (active) {
          setLoadingAgents(false);
        }
      }
    }

    loadAgents();
    return () => {
      active = false;
    };
  }, [agentId, accountId]);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);

  // Derived state sync: Reset messages when selected agent changes or loads
  const [prevAgentId, setPrevAgentId] = useState<string>(selectedAgentId);
  const [prevSelectedAgent, setPrevSelectedAgent] = useState<AIAgent | undefined>(undefined);

  if (selectedAgentId !== prevAgentId || selectedAgent !== prevSelectedAgent) {
    setPrevAgentId(selectedAgentId);
    setPrevSelectedAgent(selectedAgent);
    setMessages([
      { 
        role: "assistant", 
        content: selectedAgent 
          ? `Hi! I am ${selectedAgent.name}. I am configured with the model ${selectedAgent.model_name}. Say something to test me!` 
          : "Hi! I am ready to be tested. Say something!"
      }
    ]);
  }

  // Scroll to bottom on new messages or typing state change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  // Auto-expand textarea height
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    }
  }, [input]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isTyping) return;

    const userMsg = input.trim();
    setInput("");
    
    // Reset textarea height to auto
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    
    // Append user message
    const newMessages: Message[] = [...messages, { role: "user", content: userMsg }];
    setMessages(newMessages);
    setIsTyping(true);

    try {
      const res = await fetch(`/api/ai/agents/${selectedAgentId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMsg,
          history: messages.filter(m => m.role !== 'system') // Exclude system if we had one
        }),
      });

      if (!res.ok) throw new Error("Failed to get response");
      
      const data = await res.json();
      
      setMessages((prev) => [
        ...prev,
        { 
          role: "assistant", 
          content: data.reply,
          sources: data.sources
        }
      ]);
    } catch (err) {
      console.error(err);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "⚠️ Error communicating with the agent. Please check your API key." }
      ]);
    } finally {
      setIsTyping(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Agent Selector Controls Header */}
      <div className="bg-card border rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm">
        <div className="flex-1 max-w-xs">
          <label className="block text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
            Select Agent to Test
          </label>
          <select
            value={selectedAgentId}
            onChange={(e) => setSelectedAgentId(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-green/30 focus:border-brand-green/50"
            disabled={loadingAgents}
          >
            {loadingAgents ? (
              <option>Loading agents...</option>
            ) : agents.length === 0 ? (
              <option>No agents found</option>
            ) : (
              agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))
            )}
          </select>
        </div>
        {selectedAgent && (
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm border-t md:border-t-0 md:border-l pt-3 md:pt-0 md:pl-6 border-border flex-1 items-center">
            <div>
              <span className="text-muted-foreground mr-1.5">Model:</span>{" "}
              <span className="font-medium text-foreground bg-brand-green/10 text-brand-green px-2 py-0.5 rounded text-xs inline-flex items-center gap-1 font-mono">
                <Brain className="h-3 w-3" />
                {selectedAgent.model_name}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground mr-1.5">Temperature:</span>{" "}
              <span className="font-medium text-foreground">{selectedAgent.temperature}</span>
            </div>
            <div>
              <span className="text-muted-foreground mr-1.5">Max Tokens:</span>{" "}
              <span className="font-medium text-foreground">{selectedAgent.max_tokens}</span>
            </div>
            <div>
              <span className="text-muted-foreground mr-1.5">Status:</span>{" "}
              <span className={`inline-flex items-center gap-1.5 font-medium px-2 py-0.5 rounded-full text-xs ${
                selectedAgent.is_active 
                  ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20" 
                  : "bg-amber-500/10 text-amber-500 border border-amber-500/20"
              }`}>
                <span className={`h-1.5 w-1.5 rounded-full ${selectedAgent.is_active ? "bg-emerald-500" : "bg-amber-500"}`} />
                {selectedAgent.is_active ? "Active" : "Inactive"}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="flex h-[600px] gap-6">
        {/* Phone Mockup / Chat Interface */}
        <div className="flex flex-col w-full max-w-sm rounded-[2rem] border-[3px] border-border bg-card shadow-xl overflow-hidden relative">
          {/* Header */}
          <div className="bg-brand-green p-4 flex items-center gap-3 text-white">
            <div className="bg-white/20 p-2 rounded-full">
              <Bot className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold text-sm truncate">{selectedAgent?.name || "Test Agent"}</h3>
              <p className="text-[10px] opacity-80 truncate">{selectedAgent?.model_name || "Bot Playground"}</p>
            </div>
          </div>

          {/* Messages */}
          <div 
            ref={scrollRef} 
            className="flex-1 p-4 bg-background overflow-y-auto [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20 hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/30 [&::-webkit-scrollbar-thumb]:rounded-full"
          >
            <div className="flex flex-col gap-4 pb-4">
              {messages.map((msg, i) => (
                <div 
                  key={i} 
                  className={`flex w-max max-w-[85%] flex-col gap-1 text-sm ${
                    msg.role === "user" 
                      ? "ml-auto" 
                      : ""
                  }`}
                >
                  <div 
                    className={`px-4 py-2.5 rounded-2xl ${
                      msg.role === "user" 
                        ? "bg-brand-green text-white rounded-br-sm" 
                        : "bg-card border shadow-sm rounded-bl-sm"
                    }`}
                  >
                    {msg.content}
                  </div>
                  {/* Knowledge Base Source Attribution */}
                  {msg.sources && msg.sources.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {msg.sources.map((src, idx) => (
                        <Badge key={idx} variant="secondary" className="text-[9px] px-1.5 py-0 bg-brand-green/10 text-brand-green border-brand-green/20">
                          <Info className="h-2.5 w-2.5 mr-1" />
                          {src.source_name || src.source_type}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              
              {isTyping && (
                <div className="flex w-max max-w-[85%] flex-col gap-1 text-sm">
                  <div className="px-4 py-3 rounded-2xl bg-card border shadow-sm rounded-bl-sm flex items-center gap-1">
                    <div className="h-1.5 w-1.5 bg-muted-foreground/50 rounded-full animate-bounce" />
                    <div className="h-1.5 w-1.5 bg-muted-foreground/50 rounded-full animate-bounce [animation-delay:0.2s]" />
                    <div className="h-1.5 w-1.5 bg-muted-foreground/50 rounded-full animate-bounce [animation-delay:0.4s]" />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Input */}
          <div className="p-3 bg-background border-t">
            <form onSubmit={handleSend} className="flex items-end gap-2 relative">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend(e);
                  }
                }}
                placeholder="Type a message..."
                rows={1}
                className="flex-1 min-h-[40px] max-h-[120px] resize-none rounded-2xl py-2.5 pl-4 pr-10 bg-muted/50 border border-transparent focus-visible:ring-brand-green/30 focus:outline-none focus:ring-1 focus:ring-brand-green/30 text-sm overflow-y-auto [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20 hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/30 [&::-webkit-scrollbar-thumb]:rounded-full"
                disabled={isTyping}
              />
              <Button 
                type="submit" 
                size="icon" 
                className="absolute right-1 bottom-1 h-8 w-8 rounded-full bg-brand-green hover:bg-brand-green/90"
                disabled={!input.trim() || isTyping}
              >
                <Send className="h-4 w-4 ml-0.5" />
              </Button>
            </form>
          </div>
        </div>

        {/* Instructions / Debug panel */}
        <div className="flex-1 flex flex-col justify-center gap-4 text-muted-foreground">
          <div className="bg-brand-green/5 p-6 rounded-xl border border-brand-green/20">
            <h3 className="text-brand-green font-semibold flex items-center gap-2 mb-2">
              <Bot className="h-5 w-5" />
              Bot Playground
            </h3>
            <p className="text-sm leading-relaxed">
              Test your agent here before enabling it on your WhatsApp channels. 
              This chat interface mimics how the bot will respond to your customers.
            </p>
            <ul className="mt-4 space-y-2 text-sm">
              <li className="flex items-center gap-2">
                <div className="h-1.5 w-1.5 rounded-full bg-brand-green" />
                Test your system prompt instructions.
              </li>
              <li className="flex items-center gap-2">
                <div className="h-1.5 w-1.5 rounded-full bg-brand-green" />
                Ask questions from your Knowledge Base.
              </li>
              <li className="flex items-center gap-2">
                <div className="h-1.5 w-1.5 rounded-full bg-brand-green" />
                See which documents the bot uses (sources appear as badges).
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
