"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { SubtitleCue } from "@clipfast/shared";

interface SubtitleListProps {
  cues: SubtitleCue[];
  currentTime: number;
  onChange: (cues: SubtitleCue[]) => void;
  onSeek: (seconds: number) => void;
}

function splitCue(cue: SubtitleCue, charIdx: number): [SubtitleCue, SubtitleCue] {
  const text = cue.text;
  const ratio = Math.min(
    0.9,
    Math.max(0.1, charIdx / Math.max(1, text.length))
  );
  const splitTime = cue.start + (cue.end - cue.start) * ratio;

  const leftWords = cue.words?.filter((w) => (w.start + w.end) / 2 < splitTime);
  const rightWords = cue.words?.filter((w) => (w.start + w.end) / 2 >= splitTime);

  return [
    {
      id: crypto.randomUUID(),
      start: cue.start,
      end: splitTime,
      text: text.slice(0, charIdx).trim(),
      words: leftWords && leftWords.length > 0 ? leftWords : undefined,
    },
    {
      id: crypto.randomUUID(),
      start: splitTime,
      end: cue.end,
      text: text.slice(charIdx).trim(),
      words: rightWords && rightWords.length > 0 ? rightWords : undefined,
    },
  ];
}

function mergeCues(prev: SubtitleCue, next: SubtitleCue): SubtitleCue {
  return {
    id: crypto.randomUUID(),
    start: prev.start,
    end: next.end,
    text: `${prev.text.trim()} ${next.text.trim()}`.trim(),
    // Word timings only survive when both sides have them
    words:
      prev.words && next.words ? [...prev.words, ...next.words] : undefined,
  };
}

export function SubtitleList({
  cues,
  currentTime,
  onChange,
  onSeek,
}: SubtitleListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeIdx = cues.findIndex(
    (c) => currentTime >= c.start && currentTime < c.end
  );

  // Keep the active row visible while playing
  useEffect(() => {
    if (activeIdx < 0) return;
    const row = containerRef.current?.querySelector(`[data-idx="${activeIdx}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const updateCue = (idx: number, patch: Partial<SubtitleCue>) => {
    onChange(cues.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };

  const handleKeyDown =
    (idx: number) => (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const textarea = e.currentTarget;

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const pos = textarea.selectionStart;
        if (pos <= 0 || pos >= textarea.value.length) return;
        const [left, right] = splitCue(cues[idx], pos);
        onChange([...cues.slice(0, idx), left, right, ...cues.slice(idx + 1)]);
        return;
      }

      if (
        e.key === "Backspace" &&
        textarea.selectionStart === 0 &&
        textarea.selectionEnd === 0 &&
        idx > 0
      ) {
        e.preventDefault();
        const merged = mergeCues(cues[idx - 1], cues[idx]);
        onChange([...cues.slice(0, idx - 1), merged, ...cues.slice(idx + 1)]);
      }
    };

  if (cues.length === 0) {
    return (
      <p className="p-4 text-sm text-neutral-500">
        No subtitles on this clip yet.
      </p>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <p className="px-1 pb-2 text-[11px] text-neutral-500">
        Enter splits a cue at the cursor · Backspace at the start merges with
        the previous one · click a time to seek
      </p>
      <div ref={containerRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {cues.map((cue, idx) => (
          <div
            key={cue.id}
            data-idx={idx}
            className={cn(
              "rounded-lg border p-2 transition-colors",
              idx === activeIdx
                ? "border-yellow-300/40 bg-yellow-300/[0.06]"
                : "border-white/[0.08] bg-white/[0.02]"
            )}
          >
            <div className="flex items-center gap-1.5 pb-1.5 font-mono text-[11px] tabular-nums">
              <button
                type="button"
                onClick={() => onSeek(cue.start)}
                aria-label="Seek to cue"
                className="text-neutral-400 underline-offset-2 hover:text-white hover:underline"
              >
                ▶
              </button>
              <input
                type="number"
                step="0.1"
                min={0}
                value={Number(cue.start.toFixed(2))}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (isFinite(v) && v >= 0 && v < cue.end)
                    updateCue(idx, { start: v });
                }}
                className="w-16 rounded border border-white/[0.08] bg-transparent px-1 py-0.5 text-[11px] text-neutral-300 outline-none focus:border-white/25"
              />
              <span className="text-neutral-600">→</span>
              <input
                type="number"
                step="0.1"
                min={0}
                value={Number(cue.end.toFixed(2))}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (isFinite(v) && v > cue.start) updateCue(idx, { end: v });
                }}
                className="w-16 rounded border border-white/[0.08] bg-transparent px-1 py-0.5 text-[11px] text-neutral-300 outline-none focus:border-white/25"
              />
            </div>
            <textarea
              value={cue.text}
              rows={Math.max(1, cue.text.split("\n").length)}
              onChange={(e) =>
                // Manual text edits invalidate per-word timings for this cue
                updateCue(idx, { text: e.target.value, words: undefined })
              }
              onKeyDown={handleKeyDown(idx)}
              onFocus={() => onSeek(cue.start)}
              className="w-full resize-none bg-transparent text-sm text-white outline-none placeholder:text-neutral-600"
              placeholder="(empty cue)"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
