"use client";

import { useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface CopyFieldProps {
  label: string;
  value: string;
  /** Optional leading icon (e.g. a platform logo). */
  icon?: React.ReactNode;
}

/**
 * A monospace, read-only field with a one-tap copy affordance. Swaps to a
 * check for 1.5s and fires a toast so the user gets unmistakable feedback.
 */
export function CopyField({ label, value, icon }: CopyFieldProps) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast({ title: `${label} copied to clipboard` });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: "Couldn't copy - select and copy manually" });
    }
  }

  return (
    <div className="group flex items-center gap-3 rounded-lg border border-border bg-background/60 px-3 py-2.5 transition-colors hover:border-foreground/30">
      {icon && <span className="shrink-0 text-muted-foreground">{icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className="truncate font-mono text-sm text-foreground">{value}</div>
      </div>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${label}`}
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border transition-all",
          copied
            ? "border-emerald-500/40 text-emerald-400"
            : "text-muted-foreground hover:border-foreground/40 hover:text-foreground"
        )}
      >
        {copied ? (
          <Check weight="bold" className="h-4 w-4" />
        ) : (
          <Copy weight="duotone" className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}
