import type { Plan, BillingCycle } from "@prisma/client";
import type { TopupPack, InvoicePage, SubtitleTrack } from "@clipclap/shared";

const BASE = "";

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error: ${res.status}`);
  }

  return res.json();
}

export const api = {
  uploads: {
    getPresignedUrl: (filename: string, contentType: string, fileSizeBytes?: number) =>
      fetchApi<{ uploadUrl: string; key: string }>("/api/uploads", {
        method: "POST",
        body: JSON.stringify({ filename, contentType, fileSizeBytes }),
      }),
  },
  jobs: {
    list: () => fetchApi<JobWithClips[]>("/api/jobs"),
    get: (id: string) => fetchApi<JobWithClips>(`/api/jobs/${id}`),
    create: (data: {
      url?: string;
      sourceKey?: string;
      originalFilename?: string;
      subtitles: boolean;
      sourceDurationSec?: number;
    }) =>
      fetchApi<JobWithClips>("/api/jobs", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  },
  clips: {
    list: () => fetchApi<ClipData[]>("/api/clips"),
    get: (id: string) => fetchApi<ClipData>(`/api/clips/${id}`),
    download: (id: string) => fetchApi<{ url: string }>(`/api/clips/${id}/download`),
    subtitles: (id: string) => fetchApi<SubtitleTrack>(`/api/clips/${id}/subtitles`),
    edit: (
      id: string,
      data: {
        trim?: { start: number; end: number };
        subtitles?: boolean;
        subtitleTrack?: SubtitleTrack;
      }
    ) =>
      fetchApi<ClipData>(`/api/clips/${id}/edit`, { method: "PUT", body: JSON.stringify(data) }),
    delete: (id: string) => fetchApi<{ ok: boolean }>(`/api/clips/${id}`, { method: "DELETE" }),
  },
  billing: {
    subscription: () => fetchApi<SubscriptionData>("/api/billing/subscription"),
    checkout: (
      plan: Exclude<Plan, "NONE">,
      cycle: BillingCycle
    ) =>
      fetchApi<{ url: string }>("/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ plan, cycle }),
      }),
    topup: (pack: TopupPack) =>
      fetchApi<{ url: string }>("/api/billing/topup", {
        method: "POST",
        body: JSON.stringify({ pack }),
      }),
    portal: () =>
      fetchApi<{ url: string }>("/api/billing/portal", {
        method: "POST",
      }),
    invoices: (cursor?: string) =>
      fetchApi<InvoicePage>(
        cursor
          ? `/api/billing/invoices?after=${encodeURIComponent(cursor)}`
          : "/api/billing/invoices"
      ),
  },
};

// Types for API responses
export interface JobWithClips {
  id: string;
  userId: string;
  sourceUrl: string | null;
  sourceKey: string | null;
  originalFilename: string | null;
  status: string;
  error: string | null;
  sourceDurationSec: number | null;
  subtitles: boolean;
  createdAt: string;
  clips: ClipData[];
}

export interface ClipData {
  id: string;
  jobId: string;
  userId: string;
  title: string;
  storageKey: string;
  duration: number;
  startTime: number;
  endTime: number;
  subtitles: boolean;
  subtitleTrack?: SubtitleTrack | null;
  parentClipId: string | null;
  createdAt: string;
  description?: string | null;
  lowQuality?: boolean;
  /** The retention sweep dropped the object; the row is kept on purpose. */
  expired?: boolean;
}

export interface SubscriptionData {
  plan: string;
  subscription: {
    status: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
  } | null;
  usage: {
    plan: string;
    billingCycle: string | null;
    minutesUsed: number;
    minutesLimit: number;
    topUpMinutesRemaining: number;
    storageClipsLimit: number;
  };
}
