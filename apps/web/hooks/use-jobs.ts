"use client";

import { useState, useEffect, useCallback } from "react";
import type { JobErrorCode } from "@clipclap/shared";
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
  // `error` is a stream-level message written by us (e.g. "Job not found").
  // A FAILED job reports `errorCode` instead - its raw engine message never
  // leaves the server, and the UI renders localized copy for the code.
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<JobErrorCode | null>(null);
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
      if (data.errorCode) setErrorCode(data.errorCode);
      // FAILED is treated as terminal here, but it is not: markJobFailed writes
      // status FAILED on every BullMQ attempt and attempts is 3, so a job that
      // heals on attempt 2 has already shown the user a dead-looking failure
      // and closed the stream, which never reopens. The generic copy currently
      // absorbs that by refusing to assert either outcome (lib/job-error-text).
      //
      // The real fix is a non-final attempt the UI can see: markJobFailed would
      // have to persist BullMQ's attemptsMade (or a boolean "final") on the Job
      // row, /api/jobs/[id]/stream would emit it, and this handler would keep
      // the EventSource open and render "still working" while attempts remain -
      // with the bot's delivery notifier holding its failure message back for
      // the same reason. That is a schema + stage + stream + bot change and is
      // out of scope here.
      if (data.status === "DONE" || data.status === "FAILED") {
        setDone(true);
        eventSource.close();
      }
    };

    // Renders run for minutes; proxies and browsers drop idle SSE
    // connections. EventSource reconnects automatically as long as we do
    // NOT close it here - closing froze the page at the last status.
    eventSource.onerror = () => {};

    return () => eventSource.close();
  }, [jobId]);

  return { status, error, errorCode, clipCount, done };
}
