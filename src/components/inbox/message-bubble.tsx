"use client";

import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import type { Message, MessageReaction } from "@/types";
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  FileText,
  MapPin,
  LayoutTemplate,
  ImageOff,
  CornerDownLeft,
  ThumbsUp,
  ThumbsDown,
  Trash2,
  Edit2,
  Loader2,
  Send,
  X,
  Sparkles,
} from "lucide-react";
import { format } from "date-fns";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { InteractivePreview } from "@/components/interactive/interactive-preview";
import { useTranslations } from "next-intl";

interface MessageBubbleProps {
  message: Message;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
}

function StatusIcon({ status }: { status: Message["status"] }) {
  switch (status) {
    case "sending":
      return <Clock className="h-3 w-3 text-muted-foreground" />;
    case "sent":
      return <Check className="h-3 w-3 text-muted-foreground" />;
    case "delivered":
      return <CheckCheck className="h-3 w-3 text-muted-foreground" />;
    case "read":
      return <CheckCheck className="h-3 w-3 text-blue-400" />;
    case "failed":
      return <XCircle className="h-3 w-3 text-red-400" />;
    default:
      return null;
  }
}

function MediaUnavailable({ label, t }: { label: string, t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <ImageOff className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span>{t("unavailable", { label })}</span>
    </div>
  );
}

function MediaImage({ url, alt }: { url: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadImage = useCallback(async () => {
    if (!url) return;

    // Proxy URLs need auth fetch to create blob URL
    if (url.startsWith("/api/whatsapp/media/")) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load media");
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        setSrc(blobUrl);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    } else {
      setSrc(url);
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    loadImage();
    return () => {
      if (src?.startsWith("blob:")) {
        URL.revokeObjectURL(src);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadImage]);

  if (error) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <ImageOff className="h-8 w-8 text-muted-foreground" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <img
      src={src ?? ""}
      alt={alt}
      className="max-h-64 max-w-60 rounded-lg object-cover"
      onError={() => setError(true)}
    />
  );
}

function MessageContent({ message, t }: { message: Message, t: ReturnType<typeof useTranslations> }) {
  switch (message.content_type) {
    case "text":
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text}
        </p>
      );

    case "image":
      return (
        <div>
          {message.media_url ? (
            <MediaImage url={message.media_url} alt="Shared image" />
          ) : (
            <MediaUnavailable label={t("photo")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "video":
      return (
        <div>
          {message.media_url ? (
            <video
              src={message.media_url}
              controls
              className="max-h-64 max-w-60 rounded-lg"
            />
          ) : (
            <MediaUnavailable label={t("video")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "audio":
      return (
        <div>
          {message.media_url ? (
            <audio src={message.media_url} controls className="max-w-60" />
          ) : (
            <MediaUnavailable label={t("audio")} t={t} />
          )}
        </div>
      );

    case "document":
      if (!message.media_url) {
        return <MediaUnavailable label={message.content_text || t("document")} t={t} />;
      }
      return (
        <a
          href={message.media_url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm hover:bg-muted"
        >
          <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {message.content_text || t("document")}
          </span>
        </a>
      );

    case "template":
      return (
        <div>
          <span className="mb-1 inline-flex items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            <LayoutTemplate className="h-3 w-3" />
            {t("template")}
          </span>
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "location":
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>{message.content_text || t("locationShared")}</span>
        </div>
      );

    case "interactive": {
      // Three cases share content_type='interactive':
      //  - OUTBOUND with payload (composer / automation / Flow send after
      //    migration 035): render the buttons/list as they appear on the phone.
      //  - INBOUND tap (customer chose an option, sender_type='customer'):
      //    no payload; show the tapped option's title with a reply affordance
      //    so agents can tell it's a tap, not the customer typing.
      //  - OUTBOUND with NO payload (legacy bot/Flow sends from before
      //    migration 035 backfilled the column): show the body text plainly —
      //    it is our own message, NOT a customer tap.
      if (message.interactive_payload) {
        return <InteractivePreview payload={message.interactive_payload} />;
      }
      if (message.sender_type === "customer") {
        return (
          <div className="flex flex-col gap-0.5">
            <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <CornerDownLeft className="h-3 w-3" />
              {t("buttonReply")}
            </span>
            <p className="whitespace-pre-wrap break-words text-sm">
              {message.content_text || t("interactiveReply")}
            </p>
          </div>
        );
      }
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || t("interactiveReply")}
        </p>
      );
    }

    default:
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || t("unsupported")}
        </p>
      );
  }
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
}: MessageBubbleProps) {
  const t = useTranslations("Inbox.bubble");

  const isAgent = message.sender_type === "agent" || message.sender_type === "bot";
  const isPendingApproval = message.status === "pending_approval";
  const isBot = message.sender_type === "bot";

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content_text || "");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Feedback states
  const [showFeedbackForm, setShowFeedbackForm] = useState(false);
  const [correctionText, setCorrectionText] = useState("");
  const [feedbackNote, setFeedbackNote] = useState("");
  const [currentRating, setCurrentRating] = useState<'good' | 'bad' | null>(
    message.ai_feedback_rating || null
  );

  const time = format(new Date(message.created_at), "HH:mm");

  const handleApprove = async (textToApprove?: string) => {
    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/messages/${message.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ editedText: textToApprove }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to approve message");
      }
      toast.success("AI response approved and sent!");
      setIsEditing(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to approve");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (!confirm("Are you sure you want to reject and delete this AI draft?")) return;
    setIsSubmitting(true);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("messages")
        .delete()
        .eq("id", message.id);
      if (error) throw error;
      toast.success("AI draft discarded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to discard draft");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRating = async (rating: "good" | "bad") => {
    if (rating === "good") {
      try {
        const res = await fetch(`/api/messages/${message.id}/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating }),
        });
        if (!res.ok) throw new Error("Failed to save feedback");
        setCurrentRating("good");
        toast.success("Feedback saved! Thank you.");
      } catch (err) {
        toast.error("Failed to save rating");
      }
    } else {
      setShowFeedbackForm(true);
      setCorrectionText(message.content_text || "");
    }
  };

  const submitBadFeedback = async () => {
    if (!correctionText.trim()) {
      toast.error("Please enter what the AI should have said.");
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/messages/${message.id}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating: "bad",
          feedbackText: feedbackNote || "Human corrected response",
          correctedResponse: correctionText,
        }),
      });
      if (!res.ok) throw new Error("Failed to save feedback");
      setCurrentRating("bad");
      setShowFeedbackForm(false);
      toast.success("Correction saved and trained into AI memory!");
    } catch (err) {
      toast.error("Failed to save feedback");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-1 w-full max-w-lg",
        isAgent ? "items-end ml-auto" : "items-start",
      )}
    >
      <div
        className={cn(
          "relative rounded-2xl px-3 py-2 transition-all duration-200 shadow-sm",
          isPendingApproval
            ? "rounded-br-md border border-amber-300 bg-amber-50/95 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100 dark:border-amber-900"
            : isAgent
              ? "rounded-br-md bg-primary text-primary-foreground"
              : "rounded-bl-md bg-muted text-foreground",
        )}
      >
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            onPrimary={isAgent && !isPendingApproval}
          />
        )}
        
        {isEditing ? (
          <div className="flex flex-col gap-2 min-w-[240px]">
            <span className="text-[10px] font-semibold tracking-wide uppercase text-amber-600 dark:text-amber-400 font-sans">
              Edit AI Response
            </span>
            <textarea
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              className="w-full rounded-md border border-amber-400 bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-amber-500"
              rows={4}
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsEditing(false)}
                disabled={isSubmitting}
                className="rounded px-2.5 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/5 transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleApprove(editValue)}
                disabled={isSubmitting}
                className="flex items-center gap-1 rounded bg-amber-600 hover:bg-amber-700 text-white px-2.5 py-1 text-xs font-medium shadow-sm transition disabled:opacity-60 cursor-pointer"
              >
                {isSubmitting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Send className="h-3 w-3" />
                )}
                Save & Send
              </button>
            </div>
          </div>
        ) : (
          <>
            {isPendingApproval && (
              <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400 font-sans">
                AI Draft — Review Required
              </span>
            )}
            <MessageContent message={message} t={t} />
          </>
        )}
        <div
          className={cn(
            "mt-1 flex items-center gap-1",
            isAgent ? "justify-end" : "justify-start",
          )}
        >
          {/* AI badge — only on replies the auto-reply bot generated
              (always outbound, so it sits on the primary fill). Lets
              agents tell an AI reply from their own / a Flow's at a
              glance. */}
          {message.ai_generated && (
            <span
              className="inline-flex items-center gap-0.5 rounded-full bg-primary-foreground/20 px-1.5 py-px text-[9px] font-semibold uppercase leading-none tracking-wide text-primary-foreground"
              title={t("aiBadgeTitle")}
            >
              <Sparkles className="h-2.5 w-2.5" />
              {t("aiBadge")}
            </span>
          )}
          <span
            className={cn(
              "text-[10px]",
              isPendingApproval 
                ? "text-amber-800/70 dark:text-amber-300/70"
                : isAgent ? "text-primary-foreground/70" : "text-muted-foreground",
            )}
          >
            {time}
          </span>
          {isAgent && !isPendingApproval && <StatusIcon status={message.status} />}
        </div>
      </div>

      {/* Draft Approval Actions */}
      {isPendingApproval && !isEditing && (
        <div className="flex items-center gap-2 mt-1 px-1">
          <button
            type="button"
            onClick={() => handleApprove()}
            disabled={isSubmitting}
            className="flex items-center gap-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-2.5 py-1 shadow-sm transition disabled:opacity-60 cursor-pointer"
          >
            {isSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Approve
          </button>
          <button
            type="button"
            onClick={() => setIsEditing(true)}
            disabled={isSubmitting}
            className="flex items-center gap-1 rounded-md bg-muted text-foreground hover:bg-accent border border-border text-xs font-semibold px-2.5 py-1 shadow-sm transition disabled:opacity-60 cursor-pointer"
          >
            <Edit2 className="h-3.5 w-3.5 text-muted-foreground" />
            Edit
          </button>
          <button
            type="button"
            onClick={handleReject}
            disabled={isSubmitting}
            className="flex items-center gap-1 rounded-md bg-rose-50 text-rose-600 hover:bg-rose-100 border border-rose-200 text-xs font-semibold px-2.5 py-1 shadow-sm transition disabled:opacity-60 cursor-pointer dark:bg-rose-950/20 dark:text-rose-400 dark:border-rose-900"
          >
            {isSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            Reject
          </button>
        </div>
      )}

      {/* Bot Message Feedback & Corrective RAG Training */}
      {isBot && !isPendingApproval && (
        <div className="flex flex-col gap-1.5 mt-1 px-1 w-full items-end">
          <div className="flex items-center gap-2.5 text-[11px] text-muted-foreground">
            <span>AI Response quality:</span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => handleRating("good")}
                disabled={isSubmitting}
                className={cn(
                  "p-1 rounded-md hover:bg-muted transition cursor-pointer",
                  currentRating === "good" ? "text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30" : "text-muted-foreground"
                )}
                title="Accurate response"
              >
                <ThumbsUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => handleRating("bad")}
                disabled={isSubmitting}
                className={cn(
                  "p-1 rounded-md hover:bg-muted transition cursor-pointer",
                  currentRating === "bad" ? "text-rose-600 bg-rose-50 dark:bg-rose-950/30" : "text-muted-foreground"
                )}
                title="Inaccurate response - correct it"
              >
                <ThumbsDown className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Inline correction form */}
          {showFeedbackForm && (
            <div className="w-full rounded-lg border bg-card p-3 mt-1 shadow-sm text-left">
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-bold text-rose-600 dark:text-rose-400">Correct AI response</span>
                <button
                  type="button"
                  onClick={() => setShowFeedbackForm(false)}
                  className="p-0.5 rounded-full hover:bg-muted text-muted-foreground cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground mb-2">
                Your correction will be automatically added to the agent's knowledge base so it answers correctly next time.
              </p>
              
              <div className="space-y-2">
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground uppercase block mb-1">
                    What should the AI have said instead?
                  </label>
                  <textarea
                    value={correctionText}
                    onChange={(e) => setCorrectionText(e.target.value)}
                    className="w-full text-xs rounded border bg-background p-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    rows={3}
                    placeholder="E.g. We are closed on Sundays, but open Mon-Sat 9am-6pm."
                  />
                </div>
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground uppercase block mb-1">
                    Correction Note (Optional context)
                  </label>
                  <input
                    type="text"
                    value={feedbackNote}
                    onChange={(e) => setFeedbackNote(e.target.value)}
                    className="w-full text-xs rounded border bg-background px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    placeholder="E.g. Sunday schedule correction"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowFeedbackForm(false)}
                    className="text-xs px-2.5 py-1 hover:bg-muted rounded transition cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={submitBadFeedback}
                    disabled={isSubmitting}
                    className="flex items-center gap-1 text-xs bg-rose-600 hover:bg-rose-700 text-white font-semibold px-2.5 py-1 rounded shadow-sm transition cursor-pointer"
                  >
                    {isSubmitting && <Loader2 className="h-3 w-3 animate-spin" />}
                    Save Correction
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Display active correction summary if rated bad previously */}
          {currentRating === "bad" && message.ai_corrected_text && (
            <div className="w-full text-right text-[10px] text-rose-500 bg-rose-500/5 px-2 py-1 rounded mt-0.5">
              <span>Corrected to: </span>
              <span className="font-semibold italic text-muted-foreground">
                "{message.ai_corrected_text}"
              </span>
            </div>
          )}
        </div>
      )}

      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}
