"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowClockwise, ChatCircleDots, PaperPlaneTilt } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

export type SupportMessage = {
  id: string;
  direction: "in" | "out";
  text: string;
  deliveryStatus: "pending" | "sent" | "failed";
  dedupeKey?: string | null;
  createdAt: string | Date;
  updatedAt?: string | Date;
};

function getClientMessageId(message: SupportMessage): string | null {
  if (message.direction !== "in" || !message.dedupeKey) return null;
  return message.dedupeKey.split(":").at(-1) ?? null;
}

export function mergeSupportMessages(
  serverMessages: SupportMessage[],
  currentMessages: SupportMessage[]
): SupportMessage[] {
  const serverClientIds = new Set(serverMessages
    .map(getClientMessageId)
    .filter((id): id is string => Boolean(id)));
  const localOnly = currentMessages.filter(message => {
    const clientId = getClientMessageId(message);
    return message.id.startsWith("pending:") && clientId !== null && !serverClientIds.has(clientId);
  });
  return [...serverMessages, ...localOnly].sort((a, b) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

export async function refreshSupportConversation(signal: AbortSignal): Promise<{
  messages: SupportMessage[];
  markedRead: boolean;
} | null> {
  try {
    const response = await fetch("/api/support", { cache: "no-store", signal });
    if (!response.ok) throw new Error("Could not load support messages.");
    const data = await response.json();
    if (signal.aborted) return null;

    let markedRead = false;
    if (data.unreadIds.length > 0) {
      const marked = await fetch("/api/support/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageIds: data.unreadIds }),
        signal,
      });
      if (signal.aborted) return null;
      markedRead = marked.ok;
    }
    return { messages: data.messages as SupportMessage[], markedRead };
  } catch (cause) {
    if (signal.aborted || (cause instanceof Error && cause.name === "AbortError")) return null;
    throw cause;
  }
}

export function SupportChat({
  contextPath,
  active = true,
  className,
}: { contextPath?: string; active?: boolean; className?: string }) {
  const router = useRouter();
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await refreshSupportConversation(signal);
      if (!result || signal.aborted) return;
      setMessages(current => mergeSupportMessages(result.messages, current));
      if (result.markedRead) router.refresh();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load support messages.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(controller.signal);
    }, 5000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh(controller.signal);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, refresh]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest" }); }, [messages]);

  const send = async (messageText: string, clientMessageId = crypto.randomUUID(), replaceId?: string) => {
    const trimmed = messageText.trim();
    if (!trimmed || trimmed.length > 4000 || sending) return;
    const optimisticId = replaceId ?? `pending:${clientMessageId}`;
    const optimistic: SupportMessage = {
      id: optimisticId, direction: "in", text: trimmed, deliveryStatus: "pending",
      dedupeKey: `web:pending:${clientMessageId}`, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setMessages(current => replaceId
      ? current.map(row => row.id === replaceId ? optimistic : row)
      : [...current, optimistic]);
    setSending(true);
    setError(null);
    try {
      const response = await fetch("/api/support", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed, clientMessageId, contextPath }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Could not send your message.");
      setMessages(current => current.map(row =>
        row.id === optimisticId || getClientMessageId(row) === getClientMessageId(optimistic)
          ? data.message : row
      ));
      setText(current => current.trim() === trimmed ? "" : current);
    } catch (cause) {
      setMessages(current => current.map(row => row.id === optimisticId || getClientMessageId(row) === getClientMessageId(optimistic)
        ? { ...row, deliveryStatus: "failed" } : row));
      setError(cause instanceof Error ? cause.message : "Could not send your message.");
    } finally {
      setSending(false);
    }
  };

  const retry = (message: SupportMessage) => {
    const clientMessageId = message.dedupeKey?.split(":").at(-1);
    if (clientMessageId) void send(message.text, clientMessageId, message.id);
  };

  return (
    <section className={cn(
      "flex min-h-[32rem] flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card/40 shadow-[0_16px_60px_rgba(0,0,0,0.22)]",
      className
    )}>
      <div
        aria-label="Support conversation"
        aria-live="polite"
        className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6"
      >
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading conversation…</p>
        ) : messages.length === 0 ? (
          <div className="mx-auto flex max-w-md flex-col items-center py-16 text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-border bg-background">
              <ChatCircleDots size={24} />
            </div>
            <h2 className="font-medium">What can we help with?</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Tell us what you expected, what happened, and any error text you saw. Never send passwords or card details.
            </p>
          </div>
        ) : messages.map(message => {
          const mine = message.direction === "in";
          const retryable = message.deliveryStatus === "failed" || (
            message.deliveryStatus === "pending" && message.updatedAt !== undefined &&
            Date.now() - new Date(message.updatedAt).getTime() >= 2 * 60_000
          );
          return (
            <article key={message.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[88%] sm:max-w-[75%] ${mine ? "text-right" : "text-left"}`}>
                <p className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {mine ? "You" : "ClipClap support"}
                </p>
                <div className={`whitespace-pre-wrap break-words rounded-xl px-4 py-3 text-left text-sm leading-6 ${
                  mine ? "rounded-br-sm bg-white text-black" : "rounded-bl-sm border border-border bg-background text-foreground"
                }`}>{message.text}</div>
                <div className={`mt-1 flex items-center gap-2 px-1 text-[10px] text-muted-foreground ${mine ? "justify-end" : "justify-start"}`}>
                  <time dateTime={new Date(message.createdAt).toISOString()}>
                    {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </time>
                  {mine && message.deliveryStatus === "pending" && !retryable && <span>Sending…</span>}
                  {mine && message.deliveryStatus === "sent" && <span>Delivered</span>}
                  {mine && retryable && (
                    <button type="button" onClick={() => retry(message)} disabled={sending}
                      className="inline-flex items-center gap-1 text-red-300 underline underline-offset-2 disabled:opacity-50">
                      <ArrowClockwise size={11} /> Not sent — Retry
                    </button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
        <div ref={endRef} />
      </div>

      <div className="border-t border-border bg-background/80 p-3 backdrop-blur sm:p-4">
        {error && <p role="alert" className="mb-2 text-xs text-red-300">{error}</p>}
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor="support-message" className="sr-only">Message to support</label>
            <textarea
              id="support-message"
              aria-label="Message to support"
              value={text}
              onChange={event => setText(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void send(text);
                }
              }}
              maxLength={4000}
              rows={3}
              placeholder="Describe what happened…"
              className="block max-h-40 min-h-20 w-full resize-y rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-white/30"
            />
            <div className="mt-1 flex justify-between px-1 text-[10px] text-muted-foreground">
              <span>Ctrl/⌘ + Enter to send</span>
              {text.length >= 3500 && <span>{text.length}/4000</span>}
            </div>
          </div>
          <button type="button" onClick={() => void send(text)}
            disabled={sending || !text.trim() || text.length > 4000}
            className="flex h-10 shrink-0 items-center gap-2 rounded-lg bg-white px-4 text-sm font-medium text-black transition-colors hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40">
            <PaperPlaneTilt size={16} weight="fill" />
            <span className="hidden sm:inline">Send</span>
          </button>
        </div>
      </div>
    </section>
  );
}
