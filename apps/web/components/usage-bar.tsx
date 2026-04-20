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
