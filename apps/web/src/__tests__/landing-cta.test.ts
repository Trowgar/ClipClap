import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "apps/web/app/page.tsx"), "utf8");
const section = (start: string, end: string) =>
  source.slice(source.indexOf(start), source.indexOf(end));

describe("landing CTA hierarchy", () => {
  it("keeps browser actions primary and Telegram in its dedicated section", () => {
    expect(section("/* ── Nav ── */", "/* ── Hero ── */")).toContain("Get Started");
    expect(section("/* ── Hero ── */", "/* ── Visual Pipeline ── */")).not.toContain(
      "clipclapio_bot",
    );
    expect(section("/* ── Pricing ── */", "/* ── Affiliate ── */")).not.toContain(
      "clipclapio_bot",
    );
    expect(section("/* ── Telegram Bot Section ── */", "/* ── Pricing ── */")).toContain(
      "Open in Telegram",
    );
  });
});
