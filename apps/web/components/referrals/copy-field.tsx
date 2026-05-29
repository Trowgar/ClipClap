"use client";

import { useState } from "react";
import { useToast } from "@/hooks/use-toast";

interface CopyFieldProps {
  label: string;
  value: string;
}

/** Read-only monospace value with a plain text copy action. */
export function CopyField({ label, value }: CopyFieldProps) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast({ title: `${label} copied` });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: "Couldn't copy" });
    }
  }

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-2.5">
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="truncate font-mono text-sm">{value}</div>
      </div>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
