"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ProjectDetail as ProjectDetailData } from "@clipfast/shared";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle,
  Clock,
  FilmStrip,
  Stack,
  Trash,
} from "@phosphor-icons/react";
import { ClipCard } from "@/components/clip-card";
import { JobProgress } from "@/components/job-progress";
import { Button } from "@/components/ui/button";
import { formatDate, formatDuration } from "@/lib/utils";

export type SerializedProjectDetail = Omit<
  ProjectDetailData,
  "createdAt" | "clips"
> & {
  createdAt: string;
  clips: Array<
    Omit<ProjectDetailData["clips"][number], "createdAt"> & {
      createdAt: string;
    }
  >;
};

export function ProjectDetail({
  initialProject,
}: {
  initialProject: SerializedProjectDetail;
}) {
  const router = useRouter();
  const [project, setProject] = useState(initialProject);
  const [clips, setClips] = useState(initialProject.clips);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setProject(initialProject);
    setClips(initialProject.clips);
  }, [initialProject]);

  const handleDone = useCallback(() => {
    router.refresh();
  }, [router]);

  const handleDelete = useCallback(
    (clipId: string) => {
      setClips((current) => current.filter((clip) => clip.id !== clipId));
      router.refresh();
    },
    [router]
  );

  const handleDeleteProject = useCallback(async () => {
    const clipCount = clips.length;
    const message =
      clipCount > 0
        ? `Delete "${project.title}" and its ${clipCount} clip${clipCount === 1 ? "" : "s"}?\n\nThis cannot be undone.`
        : `Delete "${project.title}"?\n\nThis cannot be undone.`;

    if (!window.confirm(message)) return;

    setDeleting(true);
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        window.alert(data.error || "Could not delete project. Try again.");
        setDeleting(false);
        return;
      }
      router.push("/dashboard/projects");
      router.refresh();
    } catch {
      window.alert("Could not reach the server. Try again.");
      setDeleting(false);
    }
  }, [clips.length, project.id, project.title, router]);

  const isProcessing = !["DONE", "FAILED"].includes(project.status);
  const totalClipDuration = clips.reduce((sum, clip) => sum + clip.duration, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.push("/dashboard/projects")}
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Projects
      </Button>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Project
          </p>
          <h1 className="text-xl font-bold tracking-tight">{project.title}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Created {formatDate(project.createdAt)}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDeleteProject}
          disabled={deleting}
          className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash className="mr-2 h-4 w-4" />
          {deleting ? "Deleting…" : "Delete project"}
        </Button>
      </div>

      {isProcessing ? (
        <div className="rounded-lg border border-border p-4">
          <JobProgress
            jobId={project.id}
            initialStatus={project.status}
            onDone={handleDone}
          />
        </div>
      ) : project.status === "DONE" ? (
        <div className="grid gap-2 rounded-lg border border-border bg-card/40 p-2 sm:grid-cols-4">
          <ProjectMetric
            icon={<CheckCircle className="h-4 w-4 text-green-400" />}
            label="Status"
            value="Ready"
          />
          <ProjectMetric
            icon={<FilmStrip className="h-4 w-4 text-muted-foreground" />}
            label="Clips"
            value={`${clips.length}`}
          />
          <ProjectMetric
            icon={<Clock className="h-4 w-4 text-muted-foreground" />}
            label="Runtime"
            value={formatDuration(totalClipDuration)}
          />
          <ProjectMetric
            icon={<Stack className="h-4 w-4 text-muted-foreground" />}
            label="Source"
            value={
              project.sourceDurationSec
                ? formatDuration(project.sourceDurationSec)
                : project.sourceUrl
                  ? "URL"
                  : "file"
            }
          />
        </div>
      ) : (
        <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-4">
          <div className="text-sm text-destructive">
            Failed: {project.error || "Unknown error"}
          </div>
        </div>
      )}

      {clips.length > 0 && (
        <div>
          <div className="mb-4 flex items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Clips</h2>
              <p className="text-sm text-muted-foreground">
                Vertical cuts ready for review, trimming, and export.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 min-[520px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
            {clips.map((clip) => (
              <ClipCard
                key={clip.id}
                clip={clip}
                onDelete={() => handleDelete(clip.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectMetric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md px-3 py-2">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted/40">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="truncate text-sm font-medium">{value}</p>
      </div>
    </div>
  );
}
