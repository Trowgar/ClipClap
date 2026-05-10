"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ClipCard } from "@/components/clip-card";
import { JobProgress } from "@/components/job-progress";
import { Button } from "@/components/ui/button";
import { useClipsByJob } from "@/hooks/use-clips";
import { api, type JobWithClips } from "@/lib/api";

export default function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [project, setProject] = useState<JobWithClips | null>(null);
  const { clips, refresh: refreshClips } = useClipsByJob(id);

  useEffect(() => {
    api.jobs.get(id).then(setProject).catch(() => router.push("/dashboard"));
  }, [id, router]);

  const handleDone = useCallback(() => {
    refreshClips();
    api.jobs.get(id).then(setProject);
  }, [id, refreshClips]);

  if (!project) return null;

  const isProcessing = !["DONE", "FAILED"].includes(project.status);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.push("/dashboard/projects")}
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Projects
      </Button>

      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Project
        </p>
        <h1 className="text-xl font-bold tracking-tight">
          {project.originalFilename || project.sourceUrl || "Untitled project"}
        </h1>
      </div>

      <div className="rounded-lg border border-border p-4">
        {isProcessing ? (
          <JobProgress
            jobId={id}
            initialStatus={project.status}
            onDone={handleDone}
          />
        ) : project.status === "DONE" ? (
          <div className="flex items-center gap-2 text-green-500">
            <span className="text-sm font-medium">
              Project complete — {clips.length} clip
              {clips.length !== 1 ? "s" : ""} generated
            </span>
          </div>
        ) : (
          <div className="text-sm text-destructive">
            Failed: {project.error || "Unknown error"}
          </div>
        )}
      </div>

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
