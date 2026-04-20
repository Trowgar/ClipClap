"use client";

import { useState, useEffect, useCallback } from "react";
import { api, type ClipData } from "@/lib/api";

export function useClipsByJob(jobId: string) {
  const [clips, setClips] = useState<ClipData[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const job = await api.jobs.get(jobId);
      setClips(job.clips);
    } catch (err) {
      console.error("Failed to fetch clips:", err);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { clips, loading, refresh };
}

export function useClip(clipId: string) {
  const [clip, setClip] = useState<ClipData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.clips
      .get(clipId)
      .then(setClip)
      .catch((err) => console.error("Failed to fetch clip:", err))
      .finally(() => setLoading(false));
  }, [clipId]);

  return { clip, loading };
}
