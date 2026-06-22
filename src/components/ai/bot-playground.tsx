"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Bot, User, Loader2, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  sources?: any[];
}

export function BotPlayground({ agentId }: { agentId: string }) {
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", content: "Hi! I am ready to be tested. Say something!" }
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isTyping) return;

    const userMsg = input.trim();
    setInput("");
    
    // Append user message
    const newMessages: Message[] = [...messages, { role: "user", content: userMsg }];
    setMessages(newMessages);
    setIsTyping(true);

    try {
      const res = await fetch(`/api/ai/agents/${agentId}/chat`, {
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
    <div className="flex h-[600px] gap-6">
      {/* Phone Mockup / Chat Interface */}
      <div className="flex flex-col w-full max-w-sm rounded-[2rem] border-[8px] border-muted bg-background shadow-xl overflow-hidden relative">
        {/* Header */}
        <div className="bg-brand-green p-4 flex items-center gap-3 text-white">
          <div className="bg-white/20 p-2 rounded-full">
            <Bot className="h-5 w-5" />
          </div>
          <div>
            <h3 className="font-semibold text-sm">Test Agent</h3>
            <p className="text-[10px] opacity-80">Bot Playground</p>
          </div>
        </div>

        {/* Messages */}
        <ScrollArea className="flex-1 p-4 bg-slate-50 dark:bg-slate-900" ref={scrollRef}>
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
                      : "bg-white dark:bg-slate-800 border shadow-sm rounded-bl-sm"
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
                <div className="px-4 py-3 rounded-2xl bg-white dark:bg-slate-800 border shadow-sm rounded-bl-sm flex items-center gap-1">
                  <div className="h-1.5 w-1.5 bg-muted-foreground/50 rounded-full animate-bounce" />
                  <div className="h-1.5 w-1.5 bg-muted-foreground/50 rounded-full animate-bounce [animation-delay:0.2s]" />
                  <div className="h-1.5 w-1.5 bg-muted-foreground/50 rounded-full animate-bounce [animation-delay:0.4s]" />
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Input */}
        <div className="p-3 bg-background border-t">
          <form onSubmit={handleSend} className="flex items-center gap-2 relative">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type a message..."
              className="rounded-full pr-10 bg-muted/50 border-transparent focus-visible:ring-brand-green/30"
              disabled={isTyping}
            />
            <Button 
              type="submit" 
              size="icon" 
              className="absolute right-1 h-8 w-8 rounded-full bg-brand-green hover:bg-brand-green/90"
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
  );
}
