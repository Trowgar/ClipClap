"use client";

import { useState, useEffect, useCallback } from "react";
import { api, type JobWithClips } from "@/lib/api";

export function useJobs() {
  const [jobs, setJobs] = useState<JobWithClips[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api.jobs.list();
      setJobs(data);
    } catch (err) {
      console.error("Failed to fetch jobs:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { jobs, loading, refresh };
}

export function useJobProgress(jobId: string) {
  const [status, setStatus] = useState<string>("PENDING");
  const [error, setError] = useState<string | null>(null);
  const [clipCount, setClipCount] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const eventSource = new EventSource(`/api/jobs/${jobId}/stream`);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.error && !data.status) {
        setError(data.error);
        eventSource.close();
        return;
      }
      setStatus(data.status);
      setClipCount(data.clipCount || 0);
      if (data.error) setError(data.error);
      if (data.status === "DONE" || data.status === "FAILED") {
        setDone(true);
        eventSource.close();
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
    };

    return () => eventSource.close();
  }, [jobId]);

  return { status, error, clipCount, done };
}
