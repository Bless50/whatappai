"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, FileText, Link as LinkIcon, HelpCircle, Upload, Trash2, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Chunk {
  id: string;
  content: string;
  source_type: string;
  source_name: string | null;
  token_count: number;
  created_at: string;
}

export default function KnowledgeBaseDetailsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [kb, setKb] = useState<any>(null);
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);

  // Form states
  const [url, setUrl] = useState("");
  const [textTitle, setTextTitle] = useState("");
  const [textContent, setTextContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [faqs, setFaqs] = useState([{ question: "", answer: "" }]);

  useEffect(() => {
    fetchKb();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const fetchKb = async () => {
    try {
      setIsLoading(true);
      const res = await fetch(`/api/ai/knowledge/${id}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setKb(data.knowledge_base);
      setChunks(data.chunks);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteKb = async () => {
    if (!confirm("Are you sure you want to delete this knowledge base? This action cannot be undone.")) return;
    try {
      await fetch(`/api/ai/knowledge/${id}`, { method: "DELETE" });
      router.push("/knowledge-bases");
    } catch (err) {
      console.error(err);
    }
  };

  const uploadContent = async (formData: FormData) => {
    setIsUploading(true);
    try {
      const res = await fetch(`/api/ai/knowledge/${id}/content`, {
        method: "POST",
        body: formData,
      });
      
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "Failed to upload content");
        throw new Error(data.error);
      }
      
      // Refresh
      await fetchKb();
      
      // Reset forms
      setUrl("");
      setTextTitle("");
      setTextContent("");
      setFile(null);
      setFaqs([{ question: "", answer: "" }]);
    } catch (err) {
      console.error(err);
    } finally {
      setIsUploading(false);
    }
  };

  const handleUploadUrl = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;
    const fd = new FormData();
    fd.append("source_type", "url");
    fd.append("url", url);
    uploadContent(fd);
  };

  const handleUploadText = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textContent) return;
    const fd = new FormData();
    fd.append("source_type", "text");
    fd.append("title", textTitle);
    fd.append("text", textContent);
    uploadContent(fd);
  };

  const handleUploadFile = (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    const fd = new FormData();
    fd.append("source_type", "pdf");
    fd.append("file", file);
    uploadContent(fd);
  };

  const handleUploadFaqs = (e: React.FormEvent) => {
    e.preventDefault();
    const validFaqs = faqs.filter(f => f.question.trim() && f.answer.trim());
    if (validFaqs.length === 0) return;
    const fd = new FormData();
    fd.append("source_type", "faq");
    fd.append("faqs", JSON.stringify(validFaqs));
    uploadContent(fd);
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand-green" />
      </div>
    );
  }

  if (!kb) {
    return <div>Knowledge base not found.</div>;
  }

  return (
    <div className="flex flex-col gap-8 p-8 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => router.push("/knowledge-bases")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-brand-green">
              {kb.name}
            </h1>
            <p className="text-muted-foreground mt-1">
              {kb.description || "Manage documents and training data"}
            </p>
          </div>
        </div>
        <Button variant="destructive" onClick={handleDeleteKb}>
          <Trash2 className="mr-2 h-4 w-4" />
          Delete KB
        </Button>
      </div>

      <div className="grid gap-8 lg:grid-cols-3">
        {/* Left Column: Data Ingestion Tabs */}
        <div className="lg:col-span-1">
          <Card>
            <CardHeader>
              <CardTitle>Add Data</CardTitle>
              <CardDescription>Train your AI with new information.</CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="url" className="w-full">
                <TabsList className="grid w-full grid-cols-4">
                  <TabsTrigger value="url" title="URL"><LinkIcon className="h-4 w-4" /></TabsTrigger>
                  <TabsTrigger value="text" title="Text"><FileText className="h-4 w-4" /></TabsTrigger>
                  <TabsTrigger value="faq" title="FAQ"><HelpCircle className="h-4 w-4" /></TabsTrigger>
                  <TabsTrigger value="file" title="File"><Upload className="h-4 w-4" /></TabsTrigger>
                </TabsList>
                
                <TabsContent value="url" className="mt-4">
                  <form onSubmit={handleUploadUrl} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="url">Website URL</Label>
                      <Input 
                        id="url" 
                        type="url" 
                        placeholder="https://example.com/pricing" 
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        required
                      />
                      <p className="text-xs text-muted-foreground">The AI will scrape the text from this webpage.</p>
                    </div>
                    <Button type="submit" disabled={isUploading || !url} className="w-full bg-brand-green hover:bg-brand-green/90">
                      {isUploading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Process URL
                    </Button>
                  </form>
                </TabsContent>

                <TabsContent value="text" className="mt-4">
                  <form onSubmit={handleUploadText} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="title">Snippet Title</Label>
                      <Input 
                        id="title" 
                        placeholder="e.g. Return Policy" 
                        value={textTitle}
                        onChange={(e) => setTextTitle(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="content">Text Content</Label>
                      <Textarea 
                        id="content" 
                        placeholder="Paste your text here..." 
                        className="min-h-[150px]"
                        value={textContent}
                        onChange={(e) => setTextContent(e.target.value)}
                        required
                      />
                    </div>
                    <Button type="submit" disabled={isUploading || !textContent} className="w-full bg-brand-green hover:bg-brand-green/90">
                      {isUploading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Process Text
                    </Button>
                  </form>
                </TabsContent>

                <TabsContent value="faq" className="mt-4">
                  <form onSubmit={handleUploadFaqs} className="space-y-4">
                    {faqs.map((faq, i) => (
                      <div key={i} className="space-y-2 rounded-md border p-3">
                        <div>
                          <Label className="text-xs text-muted-foreground">Question</Label>
                          <Input 
                            value={faq.question}
                            onChange={(e) => {
                              const newFaqs = [...faqs];
                              newFaqs[i].question = e.target.value;
                              setFaqs(newFaqs);
                            }}
                          />
                        </div>
                        <div>
                          <Label className="text-xs text-muted-foreground">Answer</Label>
                          <Textarea 
                            className="min-h-[60px]"
                            value={faq.answer}
                            onChange={(e) => {
                              const newFaqs = [...faqs];
                              newFaqs[i].answer = e.target.value;
                              setFaqs(newFaqs);
                            }}
                          />
                        </div>
                      </div>
                    ))}
                    <Button 
                      type="button" 
                      variant="outline" 
                      className="w-full text-xs"
                      onClick={() => setFaqs([...faqs, { question: "", answer: "" }])}
                    >
                      <Plus className="mr-2 h-3 w-3" /> Add Q&A
                    </Button>
                    <Button type="submit" disabled={isUploading} className="w-full bg-brand-green hover:bg-brand-green/90">
                      {isUploading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Process FAQs
                    </Button>
                  </form>
                </TabsContent>

                <TabsContent value="file" className="mt-4">
                  <form onSubmit={handleUploadFile} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="file">Upload PDF Document</Label>
                      <Input 
                        id="file" 
                        type="file" 
                        accept="application/pdf"
                        onChange={(e) => setFile(e.target.files?.[0] || null)}
                        required
                      />
                    </div>
                    <Button type="submit" disabled={isUploading || !file} className="w-full bg-brand-green hover:bg-brand-green/90">
                      {isUploading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Process File
                    </Button>
                  </form>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Indexed Data */}
        <div className="lg:col-span-2">
          <Card className="h-full">
            <CardHeader>
              <CardTitle>Indexed Knowledge ({chunks.length} Chunks)</CardTitle>
              <CardDescription>
                When a customer asks a question, the AI will search these snippets for the answer.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {chunks.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground border border-dashed rounded-lg">
                    No data indexed yet. Upload content using the panel on the left.
                  </div>
                ) : (
                  chunks.map((chunk) => (
                    <div key={chunk.id} className="rounded-lg border p-4 hover:border-brand-green/30 transition-colors">
                      <div className="flex items-center gap-2 mb-2">
                        <Badge variant="outline" className="text-xs bg-muted/50">
                          {chunk.source_type.toUpperCase()}
                        </Badge>
                        <span className="text-sm font-medium text-muted-foreground truncate">
                          {chunk.source_name || 'Unknown Source'}
                        </span>
                        <span className="text-xs text-muted-foreground ml-auto">
                          {chunk.token_count} tokens
                        </span>
                      </div>
                      <p className="text-sm text-foreground/90 whitespace-pre-wrap line-clamp-4 leading-relaxed">
                        {chunk.content}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
