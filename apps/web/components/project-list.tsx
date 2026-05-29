"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, FilmStrip, FolderOpen, Trash } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { cn, formatDate, formatDuration } from "@/lib/utils";
import type { ProjectSummary } from "@clipfast/shared";

export type SerializedProjectSummary = Omit<
  ProjectSummary,
  "createdAt" | "clips"
> & {
  createdAt: string;
  clips: Array<Omit<ProjectSummary["clips"][number], "createdAt"> & {
    createdAt: string;
  }>;
};

interface RecentProjectsProps {
  projects: SerializedProjectSummary[];
  hasMore: boolean;
}

interface ProjectTableProps {
  projects: SerializedProjectSummary[];
}

const STATUS_COLORS: Record<string, string> = {
  PENDING: "border-yellow-500/20 bg-yellow-500/10 text-yellow-400",
  DOWNLOADING: "border-blue-500/20 bg-blue-500/10 text-blue-400",
  TRANSCRIBING: "border-blue-500/20 bg-blue-500/10 text-blue-400",
  ANALYZING: "border-purple-500/20 bg-purple-500/10 text-purple-400",
  CUTTING: "border-orange-500/20 bg-orange-500/10 text-orange-400",
  DONE: "border-green-500/20 bg-green-500/10 text-green-400",
  FAILED: "border-red-500/20 bg-red-500/10 text-red-400",
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: "queued",
  DOWNLOADING: "importing",
  TRANSCRIBING: "transcribing",
  ANALYZING: "analyzing",
  CUTTING: "rendering",
  DONE: "ready",
  FAILED: "failed",
};

export function RecentProjects({ projects, hasMore }: RecentProjectsProps) {
  if (projects.length === 0) {
    return (
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Recent Projects</h2>
        </div>
        <p className="rounded-lg border border-border py-8 text-center text-sm text-muted-foreground">
          No projects yet. Upload your first video above.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Recent Projects</h2>
        {hasMore && (
          <Link
            href="/dashboard/projects"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Show all projects
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>

      <div className="space-y-2">
        {projects.map((project) => (
          <ProjectRow key={project.id} project={project} />
        ))}
      </div>
    </section>
  );
}

export function ProjectTable({ projects: initialProjects }: ProjectTableProps) {
  const router = useRouter();
  const [projects, setProjects] = useState(initialProjects);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = useCallback(
    async (project: SerializedProjectSummary) => {
      const clipCount = project.clipCount;
      const message =
        clipCount > 0
          ? `Delete "${project.title}" and its ${clipCount} clip${clipCount === 1 ? "" : "s"}?\n\nThis cannot be undone.`
          : `Delete "${project.title}"?\n\nThis cannot be undone.`;
      if (!window.confirm(message)) return;

      setDeletingId(project.id);
      try {
        const res = await fetch(`/api/projects/${project.id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          window.alert(data.error || "Could not delete project. Try again.");
          setDeletingId(null);
          return;
        }
        setProjects((current) => current.filter((p) => p.id !== project.id));
        setDeletingId(null);
        router.refresh();
      } catch {
        window.alert("Could not reach the server. Try again.");
        setDeletingId(null);
      }
    },
    [router]
  );

  if (projects.length === 0) {
    return (
      <p className="rounded-lg border border-border py-10 text-center text-sm text-muted-foreground">
        No projects yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <div className="min-w-[600px]">
        <div className="grid grid-cols-[minmax(220px,1fr)_120px_100px_90px_40px] border-b border-border bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
          <span>Project</span>
          <span>Status</span>
          <span>Clips</span>
          <span className="text-right">Source</span>
          <span />
        </div>
        <div className="divide-y divide-border">
          {projects.map((project) => (
            <div
              key={project.id}
              className="group grid grid-cols-[minmax(220px,1fr)_120px_100px_90px_40px] items-center px-4 py-3 text-sm transition-colors hover:bg-accent"
            >
              <Link
                href={`/dashboard/projects/${project.id}`}
                className="contents"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/20 text-muted-foreground">
                    <FolderOpen className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{project.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(project.createdAt)}
                    </p>
                  </div>
                </div>
                <ProjectStatus status={project.status} />
                <span className="text-muted-foreground">
                  {project.clipCount} clip{project.clipCount !== 1 ? "s" : ""}
                </span>
                <span className="text-right text-xs text-muted-foreground">
                  {project.sourceDurationSec
                    ? formatDuration(project.sourceDurationSec)
                    : project.sourceUrl
                      ? "URL"
                      : "file"}
                </span>
              </Link>
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  handleDelete(project);
                }}
                disabled={deletingId === project.id}
                aria-label={`Delete ${project.title}`}
                className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 group-hover:opacity-100 focus:opacity-100"
              >
                <Trash className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ProjectRow({ project }: { project: SerializedProjectSummary }) {
  return (
    <Link
      href={`/dashboard/projects/${project.id}`}
      className="group grid grid-cols-[112px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-border p-2.5 transition-colors hover:bg-accent"
    >
      <ProjectPreview project={project} />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{project.title}</p>
        <p className="text-xs text-muted-foreground">
          {formatDate(project.createdAt)}
        </p>
        {project.clips[0] && (
          <p className="mt-1 truncate text-xs text-muted-foreground">
            Latest clip: {project.clips[0].title}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <ProjectStatus status={project.status} />
        <span className="w-12 text-right text-xs text-muted-foreground">
          {project.clipCount} clip{project.clipCount !== 1 ? "s" : ""}
        </span>
      </div>
    </Link>
  );
}

function ProjectPreview({ project }: { project: SerializedProjectSummary }) {
  return (
    <div className="relative aspect-video overflow-hidden rounded-md border border-white/10 bg-muted/20">
      {project.previewUrl ? (
        <video
          src={project.previewUrl}
          muted
          playsInline
          preload="metadata"
          className="h-full w-full object-cover opacity-85 transition-opacity duration-200 group-hover:opacity-100"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          <FilmStrip className="h-5 w-5" />
        </div>
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/25 to-transparent" />
    </div>
  );
}

function ProjectStatus({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "w-fit border px-2 py-0.5 text-[11px] lowercase",
        STATUS_COLORS[status] ?? "border-border text-muted-foreground"
      )}
    >
      {STATUS_LABELS[status] ?? status.toLowerCase()}
    </Badge>
  );
}
