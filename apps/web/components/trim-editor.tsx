"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Scissors, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { formatDuration } from "@/lib/utils";

interface TrimEditorProps {
  clipId: string;
  originalStart: number;
  originalEnd: number;
  originalSubtitles: boolean;
  originalPreset: string | null;
  onTrimmed?: () => void;
}

export function TrimEditor({
  clipId,
  originalStart,
  originalEnd,
  originalSubtitles,
  originalPreset,
  onTrimmed,
}: TrimEditorProps) {
  const [start, setStart] = useState(originalStart);
  const [end, setEnd] = useState(originalEnd);
  const [subtitles, setSubtitles] = useState(originalSubtitles);
  const [preset, setPreset] = useState(originalPreset || "tiktok");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const duration = end - start;
  const changed =
    start !== originalStart ||
    end !== originalEnd ||
    subtitles !== originalSubtitles ||
    preset !== originalPreset;

  const handleTrim = async () => {
    if (end <= start) {
      setError("End time must be after start time");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await api.clips.trim(clipId, {
        start,
        end,
        subtitles,
        subtitlePreset: subtitles ? preset : undefined,
      });
      onTrimmed?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Trim failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold">Trim Editor</h3>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-xs text-muted-foreground">Start (sec)</label>
          <Input
            type="number"
            step="0.1"
            value={start}
            onChange={(e) => setStart(parseFloat(e.target.value) || 0)}
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">End (sec)</label>
          <Input
            type="number"
            step="0.1"
            value={end}
            onChange={(e) => setEnd(parseFloat(e.target.value) || 0)}
          />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Duration: {formatDuration(Math.max(0, Math.round(duration)))}
      </p>

      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={subtitles}
            onCheckedChange={(v) => setSubtitles(v === true)}
          />
          Subtitles
        </label>
        {subtitles && (
          <Select value={preset} onValueChange={setPreset}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tiktok">TikTok Style</SelectItem>
              <SelectItem value="minimal">Minimal</SelectItem>
              <SelectItem value="bold">Bold</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button
        onClick={handleTrim}
        disabled={loading || !changed}
        className="w-full"
      >
        {loading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Trimming...
          </>
        ) : (
          <>
            <Scissors className="mr-2 h-4 w-4" />
            Save Trim
          </>
        )}
      </Button>
    </div>
  );
}
