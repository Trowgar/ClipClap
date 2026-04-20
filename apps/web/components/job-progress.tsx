"use client";

import { useJobProgress } from "@/hooks/use-jobs";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";

interface JobProgressProps {
  jobId: string;
  initialStatus: string;
  onDone?: () => void;
}

const STEPS = [
  "PENDING",
  "DOWNLOADING",
  "TRANSCRIBING",
  "ANALYZING",
  "CUTTING",
  "DONE",
];

export function JobProgress({ jobId, initialStatus, onDone }: JobProgressProps) {
  const { status, error, done } = useJobProgress(jobId);
  const currentStatus = status || initialStatus;

  if (done && currentStatus === "DONE" && onDone) {
    // Delay to allow state update
    setTimeout(onDone, 500);
  }

  const currentIndex = STEPS.indexOf(currentStatus);
  const isFailed = currentStatus === "FAILED";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        {isFailed ? (
          <XCircle className="h-5 w-5 text-destructive" />
        ) : currentStatus === "DONE" ? (
          <CheckCircle2 className="h-5 w-5 text-green-500" />
        ) : (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        )}
        <span className="text-sm font-medium">
          {isFailed ? "Processing failed" : currentStatus === "DONE" ? "Complete" : `Processing — ${currentStatus.toLowerCase()}...`}
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

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}
