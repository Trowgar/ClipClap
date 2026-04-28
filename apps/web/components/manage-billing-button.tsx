"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";

export function ManageBillingButton() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    setLoading(true);
    setError(null);
    try {
      const { url } = await api.billing.portal();
      if (url) window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to open portal");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button
        onClick={onClick}
        disabled={loading}
        className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm transition-colors hover:bg-accent disabled:opacity-60"
      >
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Manage billing
      </button>
      {error && <p className="mt-2 text-xs text-destructive" role="alert">{error}</p>}
    </div>
  );
}
