"use client";

import { useState } from "react";
import { Check } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

const VERDICTS = [
  { code: "AS_IS", label: "As is" },
  { code: "EDIT", label: "I'd edit it" },
  { code: "NO", label: "No" },
] as const;

const REASONS = [
  { code: "BORING", label: "Boring moment" },
  { code: "CUTOFF", label: "Cut off" },
  { code: "FRAMING", label: "Face off-screen" },
  { code: "SUBS", label: "Subtitle errors" },
  { code: "QUALITY", label: "Bad quality" },
] as const;

export function ClipFeedback({ clipId }: { clipId: string }) {
  const [verdict, setVerdict] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  // A failed write leaves the previous selection standing rather than showing
  // a state the server does not hold.
  async function send(data: { verdict?: string; reason?: string; note?: string }) {
    setSaving(true);
    try {
      await api.clips.feedback(clipId, data);
      if (data.verdict) {
        setVerdict(data.verdict);
        // A verdict change clears the reason on the server too - the reason
        // belonged to the verdict it was given under.
        setReason(null);
      }
      if (data.reason) setReason(data.reason);
    } catch (err) {
      console.error("Feedback failed:", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 border-t border-white/10 pt-3">
      <p className="text-xs opacity-60">Would you post this?</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {VERDICTS.map((v) => (
          <Button
            key={v.code}
            size="sm"
            variant={verdict === v.code ? "default" : "outline"}
            disabled={saving}
            className={verdict && verdict !== v.code ? "opacity-40" : undefined}
            onClick={() => send({ verdict: v.code })}
          >
            {verdict === v.code && <Check className="mr-1 h-3 w-3" weight="bold" />}
            {v.label}
          </Button>
        ))}
      </div>

      {/* Praise is one click; a complaint asks one more. */}
      {(verdict === "EDIT" || verdict === "NO") && (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            {REASONS.map((r) => (
              <Button
                key={r.code}
                size="sm"
                variant={reason === r.code ? "default" : "outline"}
                disabled={saving}
                className={reason && reason !== r.code ? "opacity-40" : undefined}
                onClick={() => send({ reason: r.code })}
              >
                {reason === r.code && <Check className="mr-1 h-3 w-3" weight="bold" />}
                {r.label}
              </Button>
            ))}
          </div>
          <input
            className="mt-3 w-full rounded-md border border-white/10 bg-transparent px-3 py-2 text-sm outline-none placeholder:opacity-40"
            placeholder="Anything else? (optional)"
            value={note}
            disabled={saving}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => note.trim() && send({ note: note.trim() })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && note.trim()) send({ note: note.trim() });
            }}
          />
        </>
      )}
    </div>
  );
}
