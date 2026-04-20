# ClipFast Dashboard UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete frontend dashboard, landing page, and billing UI so users can upload videos, monitor processing, view/trim/download clips, and manage their subscription.

**Architecture:** Next.js 15 App Router with shadcn/ui components, Vercel-style dark theme. Dashboard uses route group `(dashboard)` with shared sidebar layout. All data fetched from API routes built in Plan 1.

**Tech Stack:** Next.js 15, React 19, shadcn/ui, Tailwind CSS v4, Geist font, framer-motion

**Prerequisite:** Plan 1 (Foundation + Backend Pipeline) must be complete. All API routes, services, and auth are already built.

---

## File Map

```
apps/web/
├── app/
│   ├── globals.css                              # Update: add shadcn theme vars
│   ├── layout.tsx                               # Already exists
│   ├── page.tsx                                 # Rewrite: landing page
│   ├── (auth)/login/page.tsx                    # Already exists
│   └── (dashboard)/
│       ├── layout.tsx                           # NEW: sidebar layout
│       └── dashboard/
│           ├── page.tsx                          # NEW: home — upload + jobs
│           ├── jobs/[id]/page.tsx                # NEW: job progress + clips
│           ├── clips/[id]/page.tsx               # NEW: clip player + trim
│           ├── plans/page.tsx                    # NEW: plan comparison
│           └── settings/page.tsx                 # NEW: account settings
├── components/
│   ├── ui/                                      # shadcn components (auto-generated)
│   ├── sidebar.tsx                              # NEW: navigation sidebar
│   ├── user-nav.tsx                             # NEW: avatar + dropdown
│   ├── usage-bar.tsx                            # NEW: plan usage display
│   ├── upload-zone.tsx                          # NEW: drag-drop + URL input
│   ├── job-list.tsx                             # NEW: recent jobs table
│   ├── job-progress.tsx                         # NEW: SSE status tracker
│   ├── clip-card.tsx                            # NEW: clip thumbnail card
│   ├── clip-player.tsx                          # NEW: video player
│   ├── trim-editor.tsx                          # NEW: start/end adjuster
│   └── plan-card.tsx                            # NEW: pricing card
├── lib/
│   ├── auth.ts                                  # Already exists
│   └── api.ts                                   # NEW: fetch helpers
└── hooks/
    ├── use-jobs.ts                              # NEW: job data fetching
    ├── use-clips.ts                             # NEW: clip data fetching
    └── use-subscription.ts                      # NEW: billing data
```

---

## Phase 1: Foundation

### Task 1: shadcn/ui Init + Base Components

**Files:**
- Modify: `apps/web/package.json` (add dependencies)
- Modify: `apps/web/app/globals.css` (add shadcn CSS variables)
- Create: `apps/web/lib/utils.ts`
- Create: `apps/web/components.json` (shadcn config)
- Create: `apps/web/components/ui/button.tsx`
- Create: `apps/web/components/ui/card.tsx`
- Create: `apps/web/components/ui/badge.tsx`
- Create: `apps/web/components/ui/input.tsx`
- Create: `apps/web/components/ui/progress.tsx`
- Create: `apps/web/components/ui/select.tsx`
- Create: `apps/web/components/ui/checkbox.tsx`
- Create: `apps/web/components/ui/dropdown-menu.tsx`
- Create: `apps/web/components/ui/separator.tsx`
- Create: `apps/web/components/ui/toast.tsx` + `toaster.tsx` + `use-toast.ts`

- [ ] **Step 1: Add dependencies to package.json**

Add these to `apps/web/package.json` dependencies:

```json
{
  "class-variance-authority": "^0.7.1",
  "clsx": "^2.1.1",
  "tailwind-merge": "^2.6.0",
  "lucide-react": "^0.468.0",
  "@radix-ui/react-slot": "^1.1.1",
  "@radix-ui/react-select": "^2.1.5",
  "@radix-ui/react-checkbox": "^1.1.3",
  "@radix-ui/react-dropdown-menu": "^2.1.5",
  "@radix-ui/react-separator": "^1.1.1",
  "@radix-ui/react-progress": "^1.1.1",
  "@radix-ui/react-toast": "^1.2.5",
  "framer-motion": "^12.0.0"
}
```

- [ ] **Step 2: Create lib/utils.ts**

`apps/web/lib/utils.ts`:

```typescript
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatDate(date: string | Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}
```

- [ ] **Step 3: Update globals.css with shadcn dark theme variables**

Replace `apps/web/app/globals.css` with:

```css
@import "tailwindcss";

@custom-variant dark (&:is(.dark *));

:root {
  --background: 0 0% 0%;
  --foreground: 0 0% 93%;
  --card: 0 0% 7%;
  --card-foreground: 0 0% 93%;
  --popover: 0 0% 7%;
  --popover-foreground: 0 0% 93%;
  --primary: 0 0% 100%;
  --primary-foreground: 0 0% 0%;
  --secondary: 0 0% 10%;
  --secondary-foreground: 0 0% 93%;
  --muted: 0 0% 10%;
  --muted-foreground: 0 0% 53%;
  --accent: 0 0% 15%;
  --accent-foreground: 0 0% 93%;
  --destructive: 0 84% 60%;
  --destructive-foreground: 0 0% 100%;
  --border: 0 0% 20%;
  --input: 0 0% 20%;
  --ring: 0 0% 100%;
  --radius: 0.375rem;
}

body {
  background: hsl(var(--background));
  color: hsl(var(--foreground));
  font-family: var(--font-geist-sans), system-ui, sans-serif;
}

@theme inline {
  --color-background: hsl(var(--background));
  --color-foreground: hsl(var(--foreground));
  --color-card: hsl(var(--card));
  --color-card-foreground: hsl(var(--card-foreground));
  --color-popover: hsl(var(--popover));
  --color-popover-foreground: hsl(var(--popover-foreground));
  --color-primary: hsl(var(--primary));
  --color-primary-foreground: hsl(var(--primary-foreground));
  --color-secondary: hsl(var(--secondary));
  --color-secondary-foreground: hsl(var(--secondary-foreground));
  --color-muted: hsl(var(--muted));
  --color-muted-foreground: hsl(var(--muted-foreground));
  --color-accent: hsl(var(--accent));
  --color-accent-foreground: hsl(var(--accent-foreground));
  --color-destructive: hsl(var(--destructive));
  --color-destructive-foreground: hsl(var(--destructive-foreground));
  --color-border: hsl(var(--border));
  --color-input: hsl(var(--input));
  --color-ring: hsl(var(--ring));
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: var(--radius);
  --radius-lg: calc(var(--radius) + 4px);
  --radius-xl: calc(var(--radius) + 8px);
}
```

- [ ] **Step 4: Initialize shadcn components**

Run inside the web Docker container or locally:

```bash
cd apps/web
npx shadcn@latest init --defaults --force
npx shadcn@latest add button card badge input progress select checkbox dropdown-menu separator toast
```

If running in Docker is not feasible, manually create each component from the shadcn registry. The key point is these components exist in `apps/web/components/ui/`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/
git commit -m "feat: initialize shadcn/ui with dark theme and base components"
```

---

### Task 2: API Fetch Helpers + Data Hooks

**Files:**
- Create: `apps/web/lib/api.ts`
- Create: `apps/web/hooks/use-jobs.ts`
- Create: `apps/web/hooks/use-clips.ts`
- Create: `apps/web/hooks/use-subscription.ts`

- [ ] **Step 1: Create API fetch helper**

`apps/web/lib/api.ts`:

```typescript
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
  jobs: {
    list: () => fetchApi<JobWithClips[]>("/api/jobs"),
    get: (id: string) => fetchApi<JobWithClips>(`/api/jobs/${id}`),
    create: (formData: FormData) =>
      fetch("/api/jobs", { method: "POST", body: formData }).then((r) => {
        if (!r.ok) return r.json().then((b: { error?: string }) => { throw new Error(b.error || "Failed"); });
        return r.json();
      }),
  },
  clips: {
    list: () => fetchApi<ClipData[]>("/api/clips"),
    get: (id: string) => fetchApi<ClipData>(`/api/clips/${id}`),
    download: (id: string) => fetchApi<{ url: string }>(`/api/clips/${id}/download`),
    trim: (id: string, data: { start: number; end: number; subtitles: boolean; subtitlePreset?: string }) =>
      fetchApi<ClipData>(`/api/clips/${id}/trim`, { method: "POST", body: JSON.stringify(data) }),
    delete: (id: string) => fetchApi<{ ok: boolean }>(`/api/clips/${id}`, { method: "DELETE" }),
  },
  billing: {
    subscription: () => fetchApi<SubscriptionData>("/api/billing/subscription"),
    checkout: (plan: string) =>
      fetchApi<{ url: string }>("/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ plan }),
      }),
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
  subtitles: boolean;
  subtitlePreset: string | null;
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
  subtitlePreset: string | null;
  parentClipId: string | null;
  createdAt: string;
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
    videosUsed: number;
    videosLimit: number;
    maxDurationMinutes: number;
  };
}
```

- [ ] **Step 2: Create use-jobs hook**

`apps/web/hooks/use-jobs.ts`:

```typescript
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
```

- [ ] **Step 3: Create use-clips hook**

`apps/web/hooks/use-clips.ts`:

```typescript
"use client";

import { useState, useEffect, useCallback } from "react";
import { api, type ClipData } from "@/lib/api";

export function useClipsByJob(jobId: string) {
  const [clips, setClips] = useState<ClipData[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const job = await api.jobs.get(jobId);
      setClips(job.clips);
    } catch (err) {
      console.error("Failed to fetch clips:", err);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { clips, loading, refresh };
}

export function useClip(clipId: string) {
  const [clip, setClip] = useState<ClipData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.clips
      .get(clipId)
      .then(setClip)
      .catch((err) => console.error("Failed to fetch clip:", err))
      .finally(() => setLoading(false));
  }, [clipId]);

  return { clip, loading };
}
```

- [ ] **Step 4: Create use-subscription hook**

`apps/web/hooks/use-subscription.ts`:

```typescript
"use client";

import { useState, useEffect, useCallback } from "react";
import { api, type SubscriptionData } from "@/lib/api";

export function useSubscription() {
  const [data, setData] = useState<SubscriptionData | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const sub = await api.billing.subscription();
      setData(sub);
    } catch (err) {
      console.error("Failed to fetch subscription:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, refresh };
}
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/api.ts apps/web/hooks/
git commit -m "feat: add API fetch helpers and data hooks for jobs, clips, billing"
```

---

## Phase 2: Dashboard Shell

### Task 3: Sidebar + Dashboard Layout

**Files:**
- Create: `apps/web/components/sidebar.tsx`
- Create: `apps/web/components/user-nav.tsx`
- Create: `apps/web/components/usage-bar.tsx`
- Create: `apps/web/app/(dashboard)/layout.tsx`

- [ ] **Step 1: Create usage bar component**

`apps/web/components/usage-bar.tsx`:

```tsx
"use client";

import { Progress } from "@/components/ui/progress";

interface UsageBarProps {
  used: number;
  limit: number;
  plan: string;
}

export function UsageBar({ used, limit, plan }: UsageBarProps) {
  const percentage = limit > 0 ? (used / limit) * 100 : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Videos this week</span>
        <span className="font-mono">
          {used}/{limit}
        </span>
      </div>
      <Progress value={percentage} className="h-1.5" />
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          Plan: <span className="text-foreground font-medium">{plan}</span>
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create user nav component**

`apps/web/components/user-nav.tsx`:

```tsx
"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LogOut, Settings, User } from "lucide-react";

interface UserNavProps {
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export function UserNav({ name, email, avatarUrl }: UserNavProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent transition-colors outline-none">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="h-7 w-7 rounded-full"
          />
        ) : (
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-secondary">
            <User className="h-4 w-4" />
          </div>
        )}
        <span className="text-sm truncate max-w-[120px]">
          {name || email || "User"}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <div className="px-2 py-1.5">
          <p className="text-sm font-medium">{name}</p>
          <p className="text-xs text-muted-foreground truncate">{email}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href="/dashboard/settings">
            <Settings className="mr-2 h-4 w-4" />
            Settings
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href="/api/auth/signout">
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 3: Create sidebar component**

`apps/web/components/sidebar.tsx`:

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, CreditCard, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { UsageBar } from "./usage-bar";
import { UserNav } from "./user-nav";
import { Separator } from "@/components/ui/separator";

interface SidebarProps {
  user: {
    name: string | null;
    email: string | null;
    avatarUrl: string | null;
  };
  usage: {
    used: number;
    limit: number;
    plan: string;
  };
}

const navItems = [
  { href: "/dashboard", label: "Home", icon: Home },
  { href: "/dashboard/plans", label: "Plans", icon: CreditCard },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export function Sidebar({ user, usage }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="flex h-screen w-56 flex-col border-r border-border bg-background">
      {/* Logo */}
      <div className="flex h-14 items-center px-4 border-b border-border">
        <Link href="/dashboard" className="text-lg font-bold tracking-tight">
          ClipFast
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 p-3">
        {navItems.map((item) => {
          const isActive =
            item.href === "/dashboard"
              ? pathname === "/dashboard"
              : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Usage */}
      <div className="p-3">
        <UsageBar used={usage.used} limit={usage.limit} plan={usage.plan} />
        <Link
          href="/dashboard/plans"
          className="mt-2 block w-full rounded-md border border-border py-1.5 text-center text-xs font-medium transition-colors hover:bg-accent"
        >
          Upgrade
        </Link>
      </div>

      <Separator />

      {/* User */}
      <div className="p-3">
        <UserNav
          name={user.name}
          email={user.email}
          avatarUrl={user.avatarUrl}
        />
      </div>
    </aside>
  );
}
```

- [ ] **Step 4: Create dashboard layout**

`apps/web/app/(dashboard)/layout.tsx`:

```tsx
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { userService } from "@clipfast/shared";
import { Sidebar } from "@/components/sidebar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const usage = await userService.getUsage(session.user.id);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        user={{
          name: session.user.name ?? null,
          email: session.user.email ?? null,
          avatarUrl: session.user.image ?? null,
        }}
        usage={{
          used: usage.videosUsed,
          limit: usage.videosLimit,
          plan: usage.plan,
        }}
      />
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/sidebar.tsx apps/web/components/user-nav.tsx apps/web/components/usage-bar.tsx apps/web/app/\(dashboard\)/layout.tsx
git commit -m "feat: add dashboard layout with sidebar, user nav, and usage bar"
```

---

## Phase 3: Core Pages

### Task 4: Upload Zone Component

**Files:**
- Create: `apps/web/components/upload-zone.tsx`

- [ ] **Step 1: Create upload zone with drag-drop and URL input**

`apps/web/components/upload-zone.tsx`:

```tsx
"use client";

import { useState, useRef, useCallback } from "react";
import { Upload, Link, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { useRouter } from "next/navigation";

export function UploadZone() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [subtitles, setSubtitles] = useState(true);
  const [subtitlePreset, setSubtitlePreset] = useState("tiktok");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile?.type.startsWith("video/")) {
      setFile(droppedFile);
      setUrl("");
    }
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) {
      setFile(selected);
      setUrl("");
    }
  };

  const handleSubmit = async () => {
    if (!file && !url.trim()) return;
    setLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      if (file) formData.append("file", file);
      if (url.trim()) formData.append("url", url.trim());
      formData.append("subtitles", String(subtitles));
      formData.append("subtitlePreset", subtitlePreset);

      const job = await api.jobs.create(formData);
      router.push(`/dashboard/jobs/${job.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Drop zone */}
      <div
        className={cn(
          "relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors",
          dragActive
            ? "border-primary bg-accent/50"
            : "border-border hover:border-muted-foreground/50"
        )}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
      >
        <Upload className="mb-3 h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {file ? (
            <span className="text-foreground font-medium">{file.name}</span>
          ) : (
            "Drop a video file here"
          )}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => fileInputRef.current?.click()}
        >
          Choose file
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={handleFileSelect}
        />
      </div>

      {/* URL input */}
      <div className="flex items-center gap-2">
        <Link className="h-4 w-4 text-muted-foreground shrink-0" />
        <Input
          placeholder="Or paste a video URL (YouTube, TikTok, Twitch)"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (e.target.value) setFile(null);
          }}
        />
      </div>

      {/* Options */}
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={subtitles}
            onCheckedChange={(v) => setSubtitles(v === true)}
          />
          Subtitles
        </label>
        {subtitles && (
          <Select value={subtitlePreset} onValueChange={setSubtitlePreset}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tiktok">TikTok Style</SelectItem>
              <SelectItem value="minimal">Minimal</SelectItem>
              <SelectItem value="bold">Bold</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Submit */}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button
        onClick={handleSubmit}
        disabled={loading || (!file && !url.trim())}
        className="w-full"
      >
        {loading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Processing...
          </>
        ) : (
          "Process Video"
        )}
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/components/upload-zone.tsx
git commit -m "feat: add upload zone component with drag-drop, URL input, subtitle options"
```

---

### Task 5: Job List Component

**Files:**
- Create: `apps/web/components/job-list.tsx`

- [ ] **Step 1: Create job list component**

`apps/web/components/job-list.tsx`:

```tsx
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
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/components/job-list.tsx
git commit -m "feat: add job list component with status badges"
```

---

### Task 6: Dashboard Home Page

**Files:**
- Create: `apps/web/app/(dashboard)/dashboard/page.tsx`

- [ ] **Step 1: Create dashboard home page**

`apps/web/app/(dashboard)/dashboard/page.tsx`:

```tsx
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { jobService } from "@clipfast/shared";
import { UploadZone } from "@/components/upload-zone";
import { JobList } from "@/components/job-list";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const jobs = await jobService.getUserJobs(session.user.id);

  // Serialize for client components
  const serializedJobs = JSON.parse(JSON.stringify(jobs));

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Upload a video and get AI-generated clips in minutes
        </p>
      </div>

      <div className="rounded-lg border border-border p-6">
        <UploadZone />
      </div>

      <div>
        <h2 className="mb-4 text-lg font-semibold">Recent Jobs</h2>
        <JobList jobs={serializedJobs} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/\(dashboard\)/dashboard/page.tsx
git commit -m "feat: add dashboard home page with upload zone and job list"
```

---

### Task 7: Job Progress Page

**Files:**
- Create: `apps/web/components/job-progress.tsx`
- Create: `apps/web/components/clip-card.tsx`
- Create: `apps/web/app/(dashboard)/dashboard/jobs/[id]/page.tsx`

- [ ] **Step 1: Create job progress component**

`apps/web/components/job-progress.tsx`:

```tsx
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
```

- [ ] **Step 2: Create clip card component**

`apps/web/components/clip-card.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Download, Scissors, Trash2, Loader2 } from "lucide-react";
import { formatDuration } from "@/lib/utils";
import { api } from "@/lib/api";
import type { ClipData } from "@/lib/api";
import Link from "next/link";

interface ClipCardProps {
  clip: ClipData;
  onDelete?: () => void;
}

export function ClipCard({ clip, onDelete }: ClipCardProps) {
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const { url } = await api.clips.download(clip.id);
      window.open(url, "_blank");
    } catch (err) {
      console.error("Download failed:", err);
    } finally {
      setDownloading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Delete this clip?")) return;
    setDeleting(true);
    try {
      await api.clips.delete(clip.id);
      onDelete?.();
    } catch (err) {
      console.error("Delete failed:", err);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card className="overflow-hidden border-border">
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{clip.title}</p>
            <p className="text-xs text-muted-foreground">
              {formatDuration(clip.duration)}
            </p>
          </div>
          {clip.subtitles && clip.subtitlePreset && (
            <Badge variant="outline" className="shrink-0 text-xs">
              {clip.subtitlePreset}
            </Badge>
          )}
        </div>

        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={handleDownload}
            disabled={downloading}
          >
            {downloading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            <span className="ml-1.5">Download</span>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href={`/dashboard/clips/${clip.id}`}>
              <Scissors className="h-3.5 w-3.5" />
              <span className="ml-1.5">Trim</span>
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDelete}
            disabled={deleting}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
```

- [ ] **Step 3: Create job detail page**

`apps/web/app/(dashboard)/dashboard/jobs/[id]/page.tsx`:

```tsx
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
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/job-progress.tsx apps/web/components/clip-card.tsx apps/web/app/\(dashboard\)/dashboard/jobs/
git commit -m "feat: add job progress page with SSE tracking and clip cards"
```

---

### Task 8: Clip Player + Trim Editor

**Files:**
- Create: `apps/web/components/clip-player.tsx`
- Create: `apps/web/components/trim-editor.tsx`
- Create: `apps/web/app/(dashboard)/dashboard/clips/[id]/page.tsx`

- [ ] **Step 1: Create clip player**

`apps/web/components/clip-player.tsx`:

```tsx
"use client";

import { useRef, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";

interface ClipPlayerProps {
  clipId: string;
  onTimeUpdate?: (currentTime: number) => void;
  onDurationChange?: (duration: number) => void;
}

export function ClipPlayer({
  clipId,
  onTimeUpdate,
  onDurationChange,
}: ClipPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.clips
      .download(clipId)
      .then(({ url }) => setSrc(url))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [clipId]);

  if (loading) {
    return (
      <div className="flex aspect-[9/16] max-h-[500px] items-center justify-center rounded-lg bg-card">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!src) {
    return (
      <div className="flex aspect-[9/16] max-h-[500px] items-center justify-center rounded-lg bg-card">
        <p className="text-sm text-muted-foreground">Failed to load video</p>
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      src={src}
      controls
      className="aspect-[9/16] max-h-[500px] w-full rounded-lg bg-black"
      onTimeUpdate={() => {
        if (videoRef.current) onTimeUpdate?.(videoRef.current.currentTime);
      }}
      onLoadedMetadata={() => {
        if (videoRef.current) onDurationChange?.(videoRef.current.duration);
      }}
    />
  );
}
```

- [ ] **Step 2: Create trim editor**

`apps/web/components/trim-editor.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Scissors, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { formatDuration } from "@/lib/utils";

interface TrimEditorProps {
  clipId: string;
  originalStart: number;
  originalEnd: number;
  originalSubtitles: boolean;
  originalPreset: string | null;
  onTrimmed?: () => void;
}

export function TrimEditor({
  clipId,
  originalStart,
  originalEnd,
  originalSubtitles,
  originalPreset,
  onTrimmed,
}: TrimEditorProps) {
  const [start, setStart] = useState(originalStart);
  const [end, setEnd] = useState(originalEnd);
  const [subtitles, setSubtitles] = useState(originalSubtitles);
  const [preset, setPreset] = useState(originalPreset || "tiktok");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const duration = end - start;
  const changed =
    start !== originalStart ||
    end !== originalEnd ||
    subtitles !== originalSubtitles ||
    preset !== originalPreset;

  const handleTrim = async () => {
    if (end <= start) {
      setError("End time must be after start time");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await api.clips.trim(clipId, {
        start,
        end,
        subtitles,
        subtitlePreset: subtitles ? preset : undefined,
      });
      onTrimmed?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Trim failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold">Trim Editor</h3>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-xs text-muted-foreground">Start (sec)</label>
          <Input
            type="number"
            step="0.1"
            value={start}
            onChange={(e) => setStart(parseFloat(e.target.value) || 0)}
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">End (sec)</label>
          <Input
            type="number"
            step="0.1"
            value={end}
            onChange={(e) => setEnd(parseFloat(e.target.value) || 0)}
          />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Duration: {formatDuration(Math.max(0, Math.round(duration)))}
      </p>

      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={subtitles}
            onCheckedChange={(v) => setSubtitles(v === true)}
          />
          Subtitles
        </label>
        {subtitles && (
          <Select value={preset} onValueChange={setPreset}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tiktok">TikTok Style</SelectItem>
              <SelectItem value="minimal">Minimal</SelectItem>
              <SelectItem value="bold">Bold</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button
        onClick={handleTrim}
        disabled={loading || !changed}
        className="w-full"
      >
        {loading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Trimming...
          </>
        ) : (
          <>
            <Scissors className="mr-2 h-4 w-4" />
            Save Trim
          </>
        )}
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: Create clip detail page**

`apps/web/app/(dashboard)/dashboard/clips/[id]/page.tsx`:

```tsx
"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { useClip } from "@/hooks/use-clips";
import { ClipPlayer } from "@/components/clip-player";
import { TrimEditor } from "@/components/trim-editor";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Download, Loader2 } from "lucide-react";
import { formatDuration } from "@/lib/utils";
import { api } from "@/lib/api";

export default function ClipPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { clip, loading } = useClip(id);
  const [downloading, setDownloading] = useState(false);

  if (loading) return null;
  if (!clip) {
    router.push("/dashboard");
    return null;
  }

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const { url } = await api.clips.download(clip.id);
      window.open(url, "_blank");
    } catch (err) {
      console.error("Download failed:", err);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.back()}
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back
      </Button>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">{clip.title}</h1>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {formatDuration(clip.duration)}
            </span>
            {clip.subtitles && clip.subtitlePreset && (
              <Badge variant="outline">{clip.subtitlePreset}</Badge>
            )}
          </div>
        </div>
        <Button onClick={handleDownload} disabled={downloading}>
          {downloading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Download className="mr-2 h-4 w-4" />
          )}
          Download
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* Video player */}
        <ClipPlayer clipId={clip.id} />

        {/* Trim editor */}
        <TrimEditor
          clipId={clip.id}
          originalStart={clip.startTime}
          originalEnd={clip.endTime}
          originalSubtitles={clip.subtitles}
          originalPreset={clip.subtitlePreset}
          onTrimmed={() => router.push(`/dashboard/jobs/${clip.jobId}`)}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/clip-player.tsx apps/web/components/trim-editor.tsx apps/web/app/\(dashboard\)/dashboard/clips/
git commit -m "feat: add clip player page with video preview and trim editor"
```

---

## Phase 4: Billing + Settings

### Task 9: Plans Page

**Files:**
- Create: `apps/web/components/plan-card.tsx`
- Create: `apps/web/app/(dashboard)/dashboard/plans/page.tsx`

- [ ] **Step 1: Create plan card component**

`apps/web/components/plan-card.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";

interface PlanCardProps {
  name: string;
  price: string;
  period: string;
  features: string[];
  current: boolean;
  planKey?: "STARTER" | "PRO";
}

export function PlanCard({
  name,
  price,
  period,
  features,
  current,
  planKey,
}: PlanCardProps) {
  const [loading, setLoading] = useState(false);

  const handleUpgrade = async () => {
    if (!planKey) return;
    setLoading(true);
    try {
      const { url } = await api.billing.checkout(planKey);
      window.location.href = url;
    } catch (err) {
      console.error("Checkout failed:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card
      className={cn(
        "flex flex-col p-6 border-border",
        current && "border-primary"
      )}
    >
      <div className="mb-4">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-bold">{name}</h3>
          {current && <Badge>Current</Badge>}
        </div>
        <div className="mt-2">
          <span className="text-3xl font-bold">{price}</span>
          <span className="text-sm text-muted-foreground">/{period}</span>
        </div>
      </div>

      <ul className="mb-6 flex-1 space-y-2">
        {features.map((feature) => (
          <li key={feature} className="flex items-center gap-2 text-sm">
            <Check className="h-4 w-4 text-green-500 shrink-0" />
            {feature}
          </li>
        ))}
      </ul>

      {current ? (
        <Button variant="outline" disabled>
          Current Plan
        </Button>
      ) : planKey ? (
        <Button onClick={handleUpgrade} disabled={loading}>
          {loading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : null}
          Upgrade to {name}
        </Button>
      ) : (
        <Button variant="outline" disabled>
          Free
        </Button>
      )}
    </Card>
  );
}
```

- [ ] **Step 2: Create plans page**

`apps/web/app/(dashboard)/dashboard/plans/page.tsx`:

```tsx
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { userService } from "@clipfast/shared";
import { PlanCard } from "@/components/plan-card";

export default async function PlansPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const usage = await userService.getUsage(session.user.id);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Plans</h1>
        <p className="text-sm text-muted-foreground">
          Choose a plan that fits your needs. Cancel anytime.
        </p>
      </div>

      <div className="grid gap-6 sm:grid-cols-3">
        <PlanCard
          name="Free"
          price="$0"
          period="forever"
          current={usage.plan === "FREE"}
          features={[
            "2 videos per week",
            "10 min max length",
            "Basic subtitles",
            "Watermark on clips",
          ]}
        />
        <PlanCard
          name="Starter"
          price="$3"
          period="week"
          current={usage.plan === "STARTER"}
          planKey="STARTER"
          features={[
            "10 videos per week",
            "60 min max length",
            "3 subtitle styles",
            "No watermark",
            "Telegram bot access",
          ]}
        />
        <PlanCard
          name="Pro"
          price="$5"
          period="week"
          current={usage.plan === "PRO"}
          planKey="PRO"
          features={[
            "30 videos per week",
            "3 hour max length",
            "All subtitle styles",
            "No watermark",
            "Telegram bot access",
            "Priority processing",
          ]}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/plan-card.tsx apps/web/app/\(dashboard\)/dashboard/plans/
git commit -m "feat: add plans page with pricing cards and Stripe checkout"
```

---

### Task 10: Settings Page

**Files:**
- Create: `apps/web/app/(dashboard)/dashboard/settings/page.tsx`

- [ ] **Step 1: Create settings page**

`apps/web/app/(dashboard)/dashboard/settings/page.tsx`:

```tsx
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Separator } from "@/components/ui/separator";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your account settings
        </p>
      </div>

      {/* Profile */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Profile</h2>
        <div className="flex items-center gap-4 rounded-lg border border-border p-4">
          {session.user.image ? (
            <img
              src={session.user.image}
              alt=""
              className="h-12 w-12 rounded-full"
            />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-lg font-bold">
              {session.user.name?.[0] || "U"}
            </div>
          )}
          <div>
            <p className="font-medium">{session.user.name}</p>
            <p className="text-sm text-muted-foreground">
              {session.user.email}
            </p>
          </div>
        </div>
      </div>

      <Separator />

      {/* Telegram */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Telegram Bot</h2>
        <p className="text-sm text-muted-foreground">
          Connect your Telegram account to process videos via bot. Coming soon.
        </p>
      </div>

      <Separator />

      {/* Danger zone */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-destructive">Danger Zone</h2>
        <p className="text-sm text-muted-foreground">
          Account deletion is not yet available. Contact support if needed.
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/\(dashboard\)/dashboard/settings/
git commit -m "feat: add settings page with profile display"
```

---

## Phase 5: Landing Page

### Task 11: Landing Page

**Files:**
- Modify: `apps/web/app/page.tsx`

- [ ] **Step 1: Rewrite landing page with hero, features, pricing, CTA**

`apps/web/app/page.tsx`:

```tsx
import Link from "next/link";
import { ArrowRight, Zap, Clock, DollarSign, Subtitles, Video, Upload } from "lucide-react";

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      {/* Nav */}
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <span className="text-lg font-bold tracking-tight">ClipFast</span>
        <div className="flex items-center gap-4">
          <Link
            href="/login"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Sign in
          </Link>
          <Link
            href="/login"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Get Started
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-3xl px-6 py-24 text-center">
        <h1 className="text-5xl font-bold tracking-tight leading-tight">
          Turn long videos into
          <br />
          <span className="text-muted-foreground">viral short clips</span>
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-lg text-muted-foreground">
          Upload a video or paste a link. AI finds the best moments, cuts clips, and adds TikTok-style subtitles. Ready in minutes, not hours.
        </p>
        <div className="mt-8 flex items-center justify-center gap-4">
          <Link
            href="/login"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Start for free
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          No credit card required. 2 free videos per week.
        </p>
      </section>

      {/* How it works */}
      <section className="border-t border-border px-6 py-20">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-center text-3xl font-bold tracking-tight">
            How it works
          </h2>
          <div className="mt-12 grid gap-8 sm:grid-cols-3">
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-secondary">
                <Upload className="h-6 w-6" />
              </div>
              <h3 className="font-semibold">1. Upload</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Drop a video file or paste a YouTube, TikTok, or Twitch link
              </p>
            </div>
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-secondary">
                <Zap className="h-6 w-6" />
              </div>
              <h3 className="font-semibold">2. AI Analyzes</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                AI transcribes and finds the most engaging moments automatically
              </p>
            </div>
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-secondary">
                <Video className="h-6 w-6" />
              </div>
              <h3 className="font-semibold">3. Get Clips</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Download vertical clips with subtitles, ready for TikTok, Reels, Shorts
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-border px-6 py-20">
        <div className="mx-auto grid max-w-4xl gap-6 sm:grid-cols-3">
          <div className="rounded-lg border border-border p-6">
            <Clock className="mb-3 h-6 w-6 text-muted-foreground" />
            <h3 className="font-semibold">Save Hours</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              What takes 2-4 hours manually is done in minutes
            </p>
          </div>
          <div className="rounded-lg border border-border p-6">
            <DollarSign className="mb-3 h-6 w-6 text-muted-foreground" />
            <h3 className="font-semibold">3-5x Cheaper</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Starting at $3/week vs $20-40/month for competitors
            </p>
          </div>
          <div className="rounded-lg border border-border p-6">
            <Subtitles className="mb-3 h-6 w-6 text-muted-foreground" />
            <h3 className="font-semibold">Auto Subtitles</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Animated TikTok-style subtitles added automatically
            </p>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="border-t border-border px-6 py-20">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-center text-3xl font-bold tracking-tight">
            Simple pricing
          </h2>
          <p className="mt-2 text-center text-muted-foreground">
            Start free, upgrade when you need more
          </p>
          <div className="mt-12 grid gap-6 sm:grid-cols-3">
            {[
              {
                name: "Free",
                price: "$0",
                features: ["2 videos/week", "10 min max", "Basic subtitles", "Watermark"],
              },
              {
                name: "Starter",
                price: "$3/wk",
                features: ["10 videos/week", "60 min max", "3 subtitle styles", "No watermark"],
              },
              {
                name: "Pro",
                price: "$5/wk",
                features: ["30 videos/week", "3 hour max", "All styles", "Priority processing"],
              },
            ].map((plan) => (
              <div
                key={plan.name}
                className="rounded-lg border border-border p-6 text-center"
              >
                <h3 className="font-semibold">{plan.name}</h3>
                <p className="mt-2 text-3xl font-bold">{plan.price}</p>
                <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
                  {plan.features.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border px-6 py-8 text-center text-sm text-muted-foreground">
        ClipFast — AI Video Clipper
      </footer>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/page.tsx
git commit -m "feat: add landing page with hero, features, pricing sections"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] Dashboard with sidebar (Home, Plans, Settings) → Tasks 3, 6, 9, 10
- [x] File upload (drag & drop) + URL paste → Task 4
- [x] Subtitle toggle (on/off per job) + preset selection → Task 4 (UploadZone)
- [x] Job progress with SSE → Task 7 (JobProgress + useJobProgress hook)
- [x] Clip gallery with download/delete → Task 7 (ClipCard)
- [x] Clip player → Task 8 (ClipPlayer)
- [x] Clip trim editor → Task 8 (TrimEditor)
- [x] Stripe weekly subscription UI → Task 9 (PlanCard + checkout)
- [x] Usage tracking display → Task 3 (UsageBar in sidebar)
- [x] Vercel-style dark UI with Geist font → Task 1 (shadcn dark theme)
- [x] Landing page → Task 11
- [x] Settings page → Task 10
- [x] Google OAuth login → Already built in Plan 1

**Placeholder scan:** No TBD/TODO found. All code is complete.

**Type consistency:** All hooks and components reference `JobWithClips`, `ClipData`, `SubscriptionData` from `@/lib/api`. All API calls use `api.jobs.*`, `api.clips.*`, `api.billing.*` consistently.
