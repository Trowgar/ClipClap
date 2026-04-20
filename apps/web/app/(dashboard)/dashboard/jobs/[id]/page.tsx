"use client";

import { use, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { JobProgress } from "@/components/job-progress";
import { ClipCard } from "@/components/clip-card";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { useClipsByJob } from "@/hooks/use-clips";
import { api, type JobWithClips } from "@/lib/api";
import { useEffect } from "react";

export default function JobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [job, setJob] = useState<JobWithClips | null>(null);
  const { clips, refresh: refreshClips } = useClipsByJob(id);

  useEffect(() => {
    api.jobs.get(id).then(setJob).catch(() => router.push("/dashboard"));
  }, [id, router]);

  const handleDone = useCallback(() => {
    refreshClips();
    api.jobs.get(id).then(setJob);
  }, [id, refreshClips]);

  if (!job) return null;

  const isProcessing = !["DONE", "FAILED"].includes(job.status);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.push("/dashboard")}
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back
      </Button>

      <div>
        <h1 className="text-xl font-bold tracking-tight">
          {job.originalFilename || job.sourceUrl || "Video Processing"}
        </h1>
      </div>

      {/* Progress */}
      <div className="rounded-lg border border-border p-4">
        {isProcessing ? (
          <JobProgress
            jobId={id}
            initialStatus={job.status}
            onDone={handleDone}
          />
        ) : job.status === "DONE" ? (
          <div className="flex items-center gap-2 text-green-500">
            <span className="text-sm font-medium">
              Processing complete — {clips.length} clip
              {clips.length !== 1 ? "s" : ""} generated
            </span>
          </div>
        ) : (
          <div className="text-sm text-destructive">
            Failed: {job.error || "Unknown error"}
          </div>
        )}
      </div>

      {/* Clips grid */}
      {clips.length > 0 && (
        <div>
          <h2 className="mb-4 text-lg font-semibold">Clips</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {clips.map((clip) => (
              <ClipCard
                key={clip.id}
                clip={clip}
                onDelete={refreshClips}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
