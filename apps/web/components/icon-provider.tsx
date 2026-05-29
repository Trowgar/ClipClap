"use client";

import { IconContext } from "@phosphor-icons/react";
import type { ReactNode } from "react";

/**
 * Project-wide Phosphor icon defaults. `duotone` is the house style - it echoes
 * the filled play-triangle wordmark. Individual icons override `weight` where a
 * crisper glyph reads better: weight="bold" on small carets / checks / spinners,
 * weight="fill" on the solid play triangles.
 */
const ICON_DEFAULTS = { weight: "duotone" } as const;

export function IconProvider({ children }: { children: ReactNode }) {
  return (
    <IconContext.Provider value={ICON_DEFAULTS}>{children}</IconContext.Provider>
  );
}
