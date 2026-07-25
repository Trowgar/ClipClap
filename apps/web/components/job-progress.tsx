"use client";

import { useEffect } from "react";
import { useJobProgress } from "@/hooks/use-jobs";
import { jobErrorText } from "@/lib/job-error-text";
import { Badge } from "@/components/ui/badge";
import { CircleNotch, CheckCircle, XCircle } from "@phosphor-icons/react";

interface JobProgressProps {
  jobId: string;
  initialStatus: string;
  onDone?: () => void;
  /** Fires whenever the server reports a new number of rendered clips. */
  onClipCount?: (count: number) => void;
}

const STEPS = [
  "PENDING",
  "DOWNLOADING",
  "TRANSCRIBING",
  "ANALYZING",
  "CUTTING",
  "DONE",
];

export function JobProgress({
  jobId,
  initialStatus,
  onDone,
  onClipCount,
}: JobProgressProps) {
  const { status, error, errorCode, clipCount, done } = useJobProgress(jobId);
  const currentStatus = status || initialStatus;

  useEffect(() => {
    if (clipCount > 0) onClipCount?.(clipCount);
  }, [clipCount, onClipCount]);

  useEffect(() => {
    if (done && currentStatus === "DONE") onDone?.();
  }, [done, currentStatus, onDone]);

  const currentIndex = STEPS.indexOf(currentStatus);
  const isFailed = currentStatus === "FAILED";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        {isFailed ? (
          <XCircle className="h-5 w-5 text-destructive" />
        ) : currentStatus === "DONE" ? (
          <CheckCircle className="h-5 w-5 text-green-500" />
        ) : (
          <CircleNotch weight="bold" className="h-5 w-5 animate-spin text-muted-foreground" />
        )}
        <span className="text-sm font-medium">
          {isFailed ? "Processing failed" : currentStatus === "DONE" ? "Complete" : `Processing - ${currentStatus.toLowerCase()}...`}
        </span>
      </div>

      {/* Step indicators */}
      <div className="flex gap-1">
        {STEPS.slice(0, -1).map((step, i) => (
          <div
            key={step}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              isFailed && i === currentIndex
                ? "bg-destructive"
                : i < currentIndex || currentStatus === "DONE"
                  ? "bg-green-500"
                  : i === currentIndex
                    ? "bg-primary animate-pulse"
                    : "bg-secondary"
            }`}
          />
        ))}
      </div>

      {(error || isFailed) && (
        <p className="text-sm text-muted-foreground">
          {error ?? jobErrorText(errorCode)}
        </p>
      )}
    </div>
  );
}
