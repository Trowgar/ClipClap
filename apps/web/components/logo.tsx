import { cn } from "@/lib/utils";
import type { SVGProps } from "react";

/**
 * Compact play-icon mark - used for favicons and tight spots where the full
 * wordmark doesn't fit. Two right-pointing triangles. Uses `currentColor`.
 */
export function LogoMark({
  className,
  ...props
}: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn("inline-block", className)}
      {...props}
    >
      <path d="M3 7L15 16L3 25Z" />
      <path d="M16 7L28 16L16 25Z" />
    </svg>
  );
}

interface LogoProps {
  /** Tailwind sizing classes for the wordmark image (e.g. "h-6"). */
  className?: string;
}

/**
 * Full ClipClap wordmark (play icon + "CLIPCLAP" text in one lockup).
 * Rendered as a static SVG with a black background and white shapes -
 * on a dark page the black background blends in and only the white shapes
 * are visible. Set the wrapper's height; width is derived from aspect ratio.
 */
export function Logo({ className }: LogoProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/clipclap-wordmark.svg"
      alt="ClipClap"
      className={cn("block h-7 w-auto select-none", className)}
      draggable={false}
    />
  );
}
