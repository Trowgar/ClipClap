import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

describe("public SEO surface", () => {
  it("redirects the legacy Crayo URL to the canonical comparison", () => {
    const source = read("apps/web/next.config.ts");
    expect(source).toContain('source: "/crayo-ai-alternative"');
    expect(source).toContain('destination: "/crayo-alternative"');
    expect(source).toContain("permanent: true");
  });

  it("keeps the sitemap free of the redirect URL", () => {
    expect(read("apps/web/app/sitemap.ts")).not.toContain("crayo-ai-alternative");
  });

  it("keeps new Telegram product copy distinct from the comparison guide", () => {
    expect(read("apps/web/app/telegram-video-clipper-bots/page.tsx")).toContain(
      "/telegram-video-clipper",
    );
    expect(read("apps/web/lib/seo-landing-pages.ts")).toContain(
      "telegram-video-clipper-bots",
    );
  });
});
