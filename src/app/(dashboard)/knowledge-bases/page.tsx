"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { Plus, BookOpen, Trash2, Loader2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  chunk_count: number;
  created_at: string;
}

export default function KnowledgeBasesPage() {
  const { accountId } = useAuth();
  const router = useRouter();

  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  
  // Dialog state
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  useEffect(() => {
    if (!accountId) return;
    fetchKbs();
  }, [accountId]);

  const fetchKbs = async () => {
    try {
      setIsLoading(true);
      const res = await fetch(`/api/ai/knowledge?account_id=${accountId}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setKbs(data.knowledge_bases ?? []);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim() || !accountId) return;
    
    setIsCreating(true);
    try {
      const res = await fetch("/api/ai/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: accountId,
          name: newName,
          description: newDesc,
        }),
      });

      if (!res.ok) throw new Error("Failed to create KB");
      const data = await res.json();
      
      setIsCreateOpen(false);
      setNewName("");
      setNewDesc("");
      router.push(`/knowledge-bases/${data.knowledge_base.id}`);
    } catch (err) {
      console.error(err);
    } finally {
      setIsCreating(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand-green" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8 p-8 max-w-7xl mx-auto w-full">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-brand-green">
            Knowledge Bases
          </h1>
          <p className="text-muted-foreground mt-1">
            Train your AI agents by providing them with business documents, FAQs, and URLs.
          </p>
        </div>
        <Button onClick={() => setIsCreateOpen(true)} className="bg-brand-green hover:bg-brand-green/90">
          <Plus className="mr-2 h-4 w-4" />
          Create Knowledge Base
        </Button>
      </div>

      {kbs.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed p-12 text-center bg-card shadow-sm">
          <div className="rounded-full bg-brand-green/10 p-4">
            <BookOpen className="h-8 w-8 text-brand-green" />
          </div>
          <h3 className="mt-4 text-xl font-semibold">No Knowledge Bases</h3>
          <p className="mt-2 text-sm text-muted-foreground max-w-sm">
            You haven't created any knowledge bases yet. Create one to start training your AI agents.
          </p>
          <Button onClick={() => setIsCreateOpen(true)} className="mt-6 bg-brand-green hover:bg-brand-green/90">
            <Plus className="mr-2 h-4 w-4" />
            Create Knowledge Base
          </Button>
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {kbs.map((kb) => (
            <Card 
              key={kb.id} 
              className="flex flex-col cursor-pointer transition-all hover:border-brand-green/50 hover:shadow-md group"
              onClick={() => router.push(`/knowledge-bases/${kb.id}`)}
            >
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="rounded-lg bg-brand-green/10 p-2.5 w-fit">
                    <BookOpen className="h-5 w-5 text-brand-green" />
                  </div>
                </div>
                <CardTitle className="mt-4 text-xl">{kb.name}</CardTitle>
                {kb.description && (
                  <CardDescription className="line-clamp-2 mt-1">
                    {kb.description}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="flex-1">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <div className="h-2 w-2 rounded-full bg-brand-green" />
                  {kb.chunk_count} text chunks indexed
                </div>
              </CardContent>
              <CardFooter className="border-t bg-muted/20 px-6 py-4 transition-colors group-hover:bg-brand-green/5">
                <div className="flex w-full items-center justify-between text-sm font-medium text-brand-green">
                  Manage Content
                  <ArrowRight className="h-4 w-4" />
                </div>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      {/* Create Modal */}
      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Create Knowledge Base</DialogTitle>
            <DialogDescription>
              Give your knowledge base a name. You can upload documents and URLs in the next step.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="e.g. Sales Playbook, Customer Support FAQs"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="description">Description (Optional)</Label>
              <Textarea
                id="description"
                placeholder="What kind of information lives here?"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateOpen(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleCreate} 
              disabled={!newName.trim() || isCreating}
              className="bg-brand-green hover:bg-brand-green/90"
            >
              {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
