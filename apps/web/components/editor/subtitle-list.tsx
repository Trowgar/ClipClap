"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsInLineVertical,
  Play,
  Scissors,
  StackSimple,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import type { SubtitleCue } from "@clipfast/shared";

// Chunked viral-style cues are short by design; only flag near-instant ones
const MIN_CUE_SEC = 0.3;

interface SubtitleListProps {
  cues: SubtitleCue[];
  currentTime: number;
  playing: boolean;
  onChange: (cues: SubtitleCue[]) => void;
  onSeek: (seconds: number) => void;
}

export function splitCueAt(
  cue: SubtitleCue,
  charIdx: number,
  splitTimeOverride?: number
): [SubtitleCue, SubtitleCue] {
  const text = cue.text;
  const ratio = Math.min(0.9, Math.max(0.1, charIdx / Math.max(1, text.length)));
  const splitTime =
    splitTimeOverride !== undefined &&
    splitTimeOverride > cue.start &&
    splitTimeOverride < cue.end
      ? splitTimeOverride
      : cue.start + (cue.end - cue.start) * ratio;

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

export function mergeTwoCues(prev: SubtitleCue, next: SubtitleCue): SubtitleCue {
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

// Split cue text into word/gap parts so each word can be a clickable span
// (adapted from ClipSubs SubtitleList).
type WordPart =
  | { kind: "word"; text: string; start: number }
  | { kind: "gap"; text: string };

function toWordParts(cue: SubtitleCue): WordPart[] | null {
  if (!cue.words || cue.words.length === 0) return null;
  const parts: WordPart[] = [];
  let pos = 0;
  let searchFrom = 0;
  for (const word of cue.words) {
    const idx = cue.text.indexOf(word.text, searchFrom);
    if (idx === -1) continue;
    if (idx > pos) parts.push({ kind: "gap", text: cue.text.substring(pos, idx) });
    parts.push({ kind: "word", text: word.text, start: word.start });
    pos = idx + word.text.length;
    searchFrom = pos;
  }
  if (pos < cue.text.length) parts.push({ kind: "gap", text: cue.text.substring(pos) });
  return parts;
}

interface RowProps {
  cue: SubtitleCue;
  index: number;
  isActive: boolean;
  isLast: boolean;
  isOverlap: boolean;
  currentTime: number;
  onPatch: (id: string, patch: Partial<SubtitleCue>) => void;
  onSplitAtCursor: (id: string, cursor: number) => void;
  onSplitAtPlayhead: (id: string) => void;
  onMergeWithPrevious: (id: string) => void;
  onMergeWithNext: (id: string) => void;
  onDelete: (id: string) => void;
  onSeek: (seconds: number) => void;
}

function SubtitleRow({
  cue,
  index,
  isActive,
  isLast,
  isOverlap,
  currentTime,
  onPatch,
  onSplitAtCursor,
  onSplitAtPlayhead,
  onMergeWithPrevious,
  onMergeWithNext,
  onDelete,
  onSeek,
}: RowProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);

  const duration = cue.end - cue.start;
  const tooShort = duration < MIN_CUE_SEC;

  const wordParts = useMemo(() => toWordParts(cue), [cue]);
  const overlayActive = isActive && !focused && !!wordParts;

  // Active word lingers until the next one starts (reads better than gaps)
  const activeWordStart = useMemo(() => {
    if (!overlayActive || !cue.words) return -1;
    let start = -1;
    for (const w of cue.words) {
      if (currentTime >= w.start) start = w.start;
      else break;
    }
    return start;
  }, [overlayActive, cue.words, currentTime]);

  // Click in the textarea seeks proportionally to the cursor position,
  // measured in rendered pixels (ClipSubs technique).
  const seekFromCursor = (textarea: HTMLTextAreaElement) => {
    const pos = textarea.selectionStart ?? 0;
    const text = cue.text;
    if (!text.length) {
      onSeek(cue.start);
      return;
    }
    let fraction = pos / text.length;
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      const style = window.getComputedStyle(textarea);
      ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const totalPx = ctx.measureText(text).width;
      if (totalPx > 0) {
        fraction = ctx.measureText(text.substring(0, pos)).width / totalPx;
      }
    }
    onSeek(cue.start + fraction * (cue.end - cue.start));
  };

  const timeBadge = cn(
    "w-16 rounded border bg-white/[0.04] px-1 py-0.5 text-center font-mono text-[11px] tabular-nums outline-none transition-colors focus:border-white/30",
    isOverlap
      ? "border-orange-400/40 text-orange-300"
      : tooShort
        ? "border-amber-400/40 text-amber-300"
        : "border-transparent text-neutral-400"
  );

  return (
    <div
      data-idx={index}
      className={cn(
        "group flex flex-col rounded-lg border p-3 transition-colors",
        isActive
          ? "border-yellow-300/40 bg-yellow-300/[0.05] ring-1 ring-yellow-300/20"
          : isOverlap
            ? "border-orange-400/30 bg-orange-400/[0.04]"
            : tooShort
              ? "border-amber-400/25 bg-amber-400/[0.03]"
              : "border-white/[0.08] bg-white/[0.02] hover:border-white/[0.16]"
      )}
    >
      {/* Header: index + timings + duration + warnings */}
      <div className="flex flex-wrap items-center gap-2 pb-2">
        <span
          className={cn(
            "select-none text-xs font-bold",
            isActive ? "text-yellow-300/80" : "text-neutral-600"
          )}
        >
          #{index + 1}
        </span>
        <div className="flex items-center gap-1">
          <input
            type="number"
            step="0.1"
            min={0}
            value={Number(cue.start.toFixed(2))}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (isFinite(v) && v >= 0 && v < cue.end) onPatch(cue.id, { start: v });
            }}
            className={timeBadge}
            aria-label="Cue start (seconds)"
          />
          <span className="text-xs text-neutral-600">→</span>
          <input
            type="number"
            step="0.1"
            min={0}
            value={Number(cue.end.toFixed(2))}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (isFinite(v) && v > cue.start) onPatch(cue.id, { end: v });
            }}
            className={timeBadge}
            aria-label="Cue end (seconds)"
          />
        </div>
        <span
          className={cn(
            "rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-[11px] tabular-nums",
            tooShort ? "text-amber-300" : "text-neutral-500"
          )}
        >
          {duration.toFixed(2)}s
        </span>

        {isOverlap && (
          <span
            className="flex items-center gap-1 text-[11px] text-orange-300"
            title="Overlaps the previous cue"
          >
            <StackSimple size={12} /> Overlap
          </span>
        )}
        {!isOverlap && tooShort && (
          <span
            className="flex items-center gap-1 text-[11px] text-amber-300"
            title={`Duration ${duration.toFixed(2)}s - minimum is ${MIN_CUE_SEC.toFixed(1)}s`}
          >
            <WarningCircle size={12} /> Too short
          </span>
        )}
      </div>

      {/* Text area + active-word overlay */}
      <div className="relative min-w-0">
        <textarea
          ref={textareaRef}
          value={cue.text}
          rows={Math.max(1, cue.text.split("\n").length)}
          onChange={(e) =>
            // Manual text edits invalidate per-word timings for this cue
            onPatch(cue.id, { text: e.target.value, words: undefined })
          }
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const pos = e.currentTarget.selectionStart;
              if (pos > 0 && pos < e.currentTarget.value.length) {
                onSplitAtCursor(cue.id, pos);
              }
              return;
            }
            if (
              e.key === "Backspace" &&
              e.currentTarget.selectionStart === 0 &&
              e.currentTarget.selectionEnd === 0
            ) {
              e.preventDefault();
              onMergeWithPrevious(cue.id);
            }
          }}
          onClick={(e) => seekFromCursor(e.currentTarget)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Type subtitle text…"
          style={overlayActive ? { color: "transparent" } : undefined}
          className="w-full resize-none bg-transparent text-sm leading-relaxed text-white caret-white outline-none placeholder:text-neutral-600"
        />
        {overlayActive && wordParts && (
          <div
            className="absolute inset-0 cursor-text select-none overflow-hidden whitespace-pre-wrap text-sm leading-relaxed text-white"
            aria-hidden="true"
            onClick={() => textareaRef.current?.focus()}
          >
            {wordParts.map((part, i) =>
              part.kind === "gap" ? (
                <span key={i}>{part.text}</span>
              ) : (
                <span
                  key={i}
                  className={
                    part.start === activeWordStart
                      ? "rounded bg-yellow-300/90 px-0.5 text-black"
                      : ""
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    onSeek(part.start);
                  }}
                >
                  {part.text}
                </span>
              )
            )}
          </div>
        )}
      </div>

      {/* Hover toolbar */}
      <div className="mt-1.5 flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {!isLast && (
          <button
            type="button"
            title="Merge with next"
            className="rounded p-1 text-neutral-400 hover:bg-white/[0.08] hover:text-white"
            onClick={() => onMergeWithNext(cue.id)}
          >
            <ArrowsInLineVertical size={14} />
          </button>
        )}
        <button
          type="button"
          title="Split at playhead"
          className="rounded p-1 text-neutral-400 hover:bg-white/[0.08] hover:text-white"
          onClick={() => onSplitAtPlayhead(cue.id)}
        >
          <Scissors size={14} />
        </button>
        <button
          type="button"
          title="Play from here"
          className="rounded p-1 text-neutral-400 hover:bg-white/[0.08] hover:text-white"
          onClick={() => onSeek(cue.start)}
        >
          <Play size={14} weight="fill" />
        </button>
        <button
          type="button"
          title="Delete cue"
          className="rounded p-1 text-red-400/70 hover:bg-red-400/10 hover:text-red-400"
          onClick={() => onDelete(cue.id)}
        >
          <Trash size={14} />
        </button>
      </div>
    </div>
  );
}

export function SubtitleList({
  cues,
  currentTime,
  playing,
  onChange,
  onSeek,
}: SubtitleListProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const activeIdx = useMemo(
    () => cues.findIndex((c) => currentTime >= c.start && currentTime < c.end),
    [cues, currentTime]
  );

  const { overlaps, tooShortCount } = useMemo(() => {
    const overlaps: number[] = [];
    let tooShortCount = 0;
    for (let i = 0; i < cues.length; i++) {
      if (i > 0 && cues[i].start < cues[i - 1].end - 0.001) overlaps.push(i);
      if (cues[i].end - cues[i].start < MIN_CUE_SEC) tooShortCount += 1;
    }
    return { overlaps, tooShortCount };
  }, [cues]);

  // Keep the active row visible during playback
  useEffect(() => {
    if (!playing || activeIdx < 0) return;
    const row = listRef.current?.querySelector(`[data-idx="${activeIdx}"]`);
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIdx, playing]);

  const patch = (id: string, p: Partial<SubtitleCue>) =>
    onChange(cues.map((c) => (c.id === id ? { ...c, ...p } : c)));

  const splitAtCursor = (id: string, cursor: number) => {
    const idx = cues.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const [left, right] = splitCueAt(cues[idx], cursor);
    onChange([...cues.slice(0, idx), left, right, ...cues.slice(idx + 1)]);
  };

  const splitAtPlayhead = (id: string) => {
    const idx = cues.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const cue = cues[idx];
    const cursor = Math.round(
      cue.text.length *
        Math.min(0.9, Math.max(0.1, (currentTime - cue.start) / (cue.end - cue.start)))
    );
    const [left, right] = splitCueAt(cue, cursor, currentTime);
    onChange([...cues.slice(0, idx), left, right, ...cues.slice(idx + 1)]);
  };

  const mergeWithPrevious = (id: string) => {
    const idx = cues.findIndex((c) => c.id === id);
    if (idx <= 0) return;
    const merged = mergeTwoCues(cues[idx - 1], cues[idx]);
    onChange([...cues.slice(0, idx - 1), merged, ...cues.slice(idx + 1)]);
  };

  const mergeWithNext = (id: string) => {
    const idx = cues.findIndex((c) => c.id === id);
    if (idx < 0 || idx >= cues.length - 1) return;
    const merged = mergeTwoCues(cues[idx], cues[idx + 1]);
    onChange([...cues.slice(0, idx), merged, ...cues.slice(idx + 2)]);
  };

  const deleteCue = (id: string) => onChange(cues.filter((c) => c.id !== id));

  const jumpToNextIssue = (indexes: number[]) => {
    if (indexes.length === 0) return;
    const next =
      indexes.find((i) => cues[i].start > currentTime + 0.1) ?? indexes[0];
    onSeek(cues[next].start);
  };

  const tooShortIdx = cues
    .map((c, i) => (c.end - c.start < MIN_CUE_SEC ? i : -1))
    .filter((i) => i >= 0);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02]">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/[0.08] px-3 py-2.5">
        <div className="flex items-center gap-2 overflow-x-auto">
          <h3 className="whitespace-nowrap text-sm font-semibold text-white">
            Subtitles <span className="text-neutral-500">({cues.length})</span>
          </h3>
          {tooShortCount > 0 && (
            <button
              type="button"
              onClick={() => jumpToNextIssue(tooShortIdx)}
              className="flex items-center gap-1 whitespace-nowrap rounded-md border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-400/20"
              title="Jump to next too-short cue"
            >
              <WarningCircle size={12} />
              {tooShortCount} too short
            </button>
          )}
          {overlaps.length > 0 && (
            <button
              type="button"
              onClick={() => jumpToNextIssue(overlaps)}
              className="flex items-center gap-1 whitespace-nowrap rounded-md border border-orange-400/30 bg-orange-400/10 px-1.5 py-0.5 text-[11px] font-medium text-orange-300 transition-colors hover:bg-orange-400/20"
              title="Jump to next overlap"
            >
              <StackSimple size={12} />
              {overlaps.length} overlap
            </button>
          )}
        </div>
        <span className="hidden whitespace-nowrap text-[11px] text-neutral-500 xl:block">
          Enter splits · Backspace at start merges
        </span>
      </div>

      {/* Rows */}
      <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {cues.length === 0 ? (
          <p className="p-4 text-sm text-neutral-500">
            No subtitles on this clip yet.
          </p>
        ) : (
          cues.map((cue, idx) => (
            <SubtitleRow
              key={cue.id}
              cue={cue}
              index={idx}
              isActive={idx === activeIdx}
              isLast={idx === cues.length - 1}
              isOverlap={idx > 0 && cue.start < cues[idx - 1].end - 0.001}
              currentTime={currentTime}
              onPatch={patch}
              onSplitAtCursor={splitAtCursor}
              onSplitAtPlayhead={splitAtPlayhead}
              onMergeWithPrevious={mergeWithPrevious}
              onMergeWithNext={mergeWithNext}
              onDelete={deleteCue}
              onSeek={onSeek}
            />
          ))
        )}
      </div>
    </div>
  );
}
