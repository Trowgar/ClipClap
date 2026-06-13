"use client";

import { useSyncExternalStore } from "react";
import { formatDate } from "@/lib/utils";

const subscribe = () => () => {};

/**
 * Renders a date formatted in the VISITOR's timezone without an SSR/CSR
 * hydration mismatch: the server (UTC) emits an empty placeholder and the
 * real text appears right after hydration.
 */
export function LocalDate({
  date,
  format = "datetime",
}: {
  date: string | Date;
  format?: "datetime" | "date";
}) {
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
  if (!mounted) return <span suppressHydrationWarning />;
  const text =
    format === "date"
      ? new Date(date).toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : formatDate(date);
  return <span suppressHydrationWarning>{text}</span>;
}
