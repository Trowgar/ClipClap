"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { trackConversion } from "@/lib/conversion";

export function ConversionImpression({ event, detail, children }: {
  event: string; detail: Record<string, unknown>; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const serialized = JSON.stringify(detail);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let visible = false, sent = false;
    const report = () => {
      if (!sent && visible && document.visibilityState === "visible") {
        sent = true;
        trackConversion(event, JSON.parse(serialized));
      }
    };
    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      report();
    });
    observer.observe(node);
    document.addEventListener("visibilitychange", report);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", report); };
  }, [event, serialized]);
  return <div ref={ref} onClickCapture={e => {
    if (event === "offer_shown" && (e.target as HTMLElement).closest("a")) {
      trackConversion("offer_clicked", detail);
    }
  }}>{children}</div>;
}
