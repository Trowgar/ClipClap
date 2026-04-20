"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import type { JobWithClips } from "@/lib/api";

interface JobListProps {
  jobs: JobWithClips[];
}

const STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
  DOWNLOADING: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  TRANSCRIBING: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  ANALYZING: "bg-purple-500/10 text-purple-500 border-purple-500/20",
  CUTTING: "bg-orange-500/10 text-orange-500 border-orange-500/20",
  DONE: "bg-green-500/10 text-green-500 border-green-500/20",
  FAILED: "bg-red-500/10 text-red-500 border-red-500/20",
};

export function JobList({ jobs }: JobListProps) {
  if (jobs.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No videos processed yet. Upload your first video above.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {jobs.map((job) => (
        <Link
          key={job.id}
          href={`/dashboard/jobs/${job.id}`}
          className="flex items-center justify-between rounded-lg border border-border p-3 transition-colors hover:bg-accent"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">
                {job.originalFilename || job.sourceUrl || "Video"}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatDate(job.createdAt)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <Badge variant="outline" className={STATUS_COLORS[job.status]}>
              {job.status.toLowerCase()}
            </Badge>
            {job.clips.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {job.clips.length} clip{job.clips.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </Link>
      ))}
    </div>
  );
}
