"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CircleNotch } from "@phosphor-icons/react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

const METHODS = [
  { value: "USDT_TRC20", label: "USDT (TRC20)", hint: "TRON address (starts with T)" },
  { value: "PAYPAL", label: "PayPal", hint: "PayPal email address" },
  { value: "BANK", label: "Bank transfer", hint: "IBAN / account details" },
] as const;

interface PayoutFormProps {
  currentMethod: string | null;
  currentDestination: string | null;
}

export function PayoutForm({ currentMethod, currentDestination }: PayoutFormProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [method, setMethod] = useState(currentMethod ?? "USDT_TRC20");
  const [destination, setDestination] = useState(currentDestination ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [, startTransition] = useTransition();

  const hint = METHODS.find((m) => m.value === method)?.hint ?? "";
  const dirty = method !== currentMethod || destination !== (currentDestination ?? "");

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/referrals/payout-destination", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, destination }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Couldn't save");
        return;
      }
      toast({ title: "Payout destination saved" });
      startTransition(() => router.refresh());
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select value={method} onValueChange={setMethod}>
          <SelectTrigger className="sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {METHODS.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder={hint}
          className="flex-1 font-mono"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty || destination.trim().length === 0}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {saving && <CircleNotch weight="bold" className="h-3.5 w-3.5 animate-spin" />}
          Save
        </button>
      </div>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
