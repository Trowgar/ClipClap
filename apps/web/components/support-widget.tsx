"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ChatCircleDots, X } from "@phosphor-icons/react";
import { SupportChat } from "@/components/support-chat";
import { cn } from "@/lib/utils";

export function getSupportOpenPath(pathname: string, supportQuery: string | null): string | null {
  return supportQuery === "open" ? pathname : null;
}

export function SupportWidget({ unread }: { unread: number }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const supportQuery = searchParams.get("support");
  const initiallyOpen = getSupportOpenPath(pathname, supportQuery) !== null;
  const [open, setOpen] = useState(initiallyOpen);
  const [hasOpened, setHasOpened] = useState(initiallyOpen);
  const [displayedUnread, setDisplayedUnread] = useState(initiallyOpen ? 0 : unread);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const show = () => {
    setDisplayedUnread(0);
    setHasOpened(true);
    setOpen(true);
  };
  const close = useCallback(() => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => { setDisplayedUnread(unread); }, [unread]);

  useEffect(() => {
    if (getSupportOpenPath(pathname, supportQuery) === null) return;
    setDisplayedUnread(0);
    setHasOpened(true);
    setOpen(true);
  }, [pathname, supportQuery]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open]);

  return (
    <>
      {hasOpened && (
        <>
          <div
            aria-hidden="true"
            className={cn("fixed inset-0 z-50 bg-black/60 sm:bg-transparent", !open && "hidden")}
            onClick={close}
          />
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Support chat"
            className={cn(
              "fixed inset-x-0 bottom-0 z-[60] flex h-[min(85dvh,44rem)] flex-col overflow-hidden rounded-t-2xl border border-border bg-background pb-[env(safe-area-inset-bottom)] shadow-[0_-20px_70px_rgba(0,0,0,0.45)]",
              "sm:inset-x-auto sm:bottom-20 sm:right-4 sm:h-[min(40rem,calc(100dvh-6rem))] sm:w-[25rem] sm:rounded-xl sm:pb-0 sm:shadow-[0_20px_70px_rgba(0,0,0,0.5)]",
              !open && "hidden"
            )}
          >
            <header className="flex shrink-0 items-start gap-3 border-b border-border bg-card/70 px-4 py-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold">Support</h2>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  This isn’t live chat, so replies may take time.
                </p>
              </div>
              <button
                ref={closeRef}
                type="button"
                aria-label="Close support chat"
                onClick={close}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={18} />
              </button>
            </header>
            <SupportChat
              active={open}
              contextPath={pathname}
              className="min-h-0 rounded-none border-0 bg-transparent shadow-none"
            />
          </div>
        </>
      )}

      <button
        ref={triggerRef}
        type="button"
        aria-label={displayedUnread > 0
          ? `Open support chat, ${displayedUnread} unread ${displayedUnread === 1 ? "reply" : "replies"}`
          : "Open support chat"}
        aria-expanded={open}
        onClick={show}
        className={cn(
          "fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-[70] flex h-12 w-12 items-center justify-center rounded-full border border-white/15 bg-white text-black shadow-[0_12px_35px_rgba(0,0,0,0.45)] transition-transform hover:scale-105 hover:bg-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black sm:h-11 sm:w-11",
          open && "max-sm:hidden"
        )}
      >
        <ChatCircleDots size={21} weight="fill" />
        {displayedUnread > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-1.5 -top-1.5 min-w-5 rounded-full border-2 border-background bg-red-500 px-1 py-0.5 text-center text-[10px] font-bold leading-none text-white"
          >
            {displayedUnread > 99 ? "99+" : displayedUnread}
          </span>
        )}
      </button>
    </>
  );
}
