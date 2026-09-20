import { describe, expect, it } from "vitest";
import { PRODUCT_SEO_PAGES } from "../../lib/seo-landing-pages";

const EXPECTED_SLUGS = [
  "ai-video-clipper",
  "podcast-to-shorts",
  "twitch-clip-maker",
  "youtube-to-shorts",
  "telegram-video-clipper",
] as const;

describe("US product SEO page contract", () => {
  it("owns exactly the five approved product intents", () => {
    expect(PRODUCT_SEO_PAGES.map((page) => page.slug)).toEqual(EXPECTED_SLUGS);
  });

  it("keeps metadata unique and concise", () => {
    expect(new Set(PRODUCT_SEO_PAGES.map((page) => page.title)).size).toBe(5);
    expect(new Set(PRODUCT_SEO_PAGES.map((page) => page.description)).size).toBe(5);
    for (const page of PRODUCT_SEO_PAGES) {
      expect(page.description.length).toBeLessThanOrEqual(165);
      expect(page.h1.toLowerCase()).toContain(page.primaryKeyword.toLowerCase());
    }
  });

  it("uses only known internal related-page slugs", () => {
    const known = new Set(EXPECTED_SLUGS);
    known.add("/");
    known.add("telegram-video-clipper-bots");
    known.add("ai-clipping-tools-compared");
    known.add("opus-clip-alternative");
    known.add("submagic-alternative");
    known.add("eklipse-alternative");
    known.add("klap-alternative");
    known.add("crayo-alternative");
    for (const page of PRODUCT_SEO_PAGES) {
      for (const related of page.relatedSlugs) expect(known.has(related)).toBe(true);
    }
  });

  it("keeps every intent specific instead of keyword-swapping one paragraph", () => {
    for (const page of PRODUCT_SEO_PAGES) {
      expect(page.workflow.length).toBeGreaterThanOrEqual(3);
      expect(page.limitations.length).toBeGreaterThanOrEqual(2);
      expect(page.intro.toLowerCase()).toContain(page.primaryKeyword.toLowerCase());
    }
  });
});
