import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.stubGlobal("React", React);

import SupportPage from "../../app/(dashboard)/dashboard/support/page";

it("renders an honest, accessible support conversation", async () => {
  const html = renderToStaticMarkup(await SupportPage({
    searchParams: Promise.resolve({ from: "/dashboard/projects/p1" }),
  }));
  expect(html).toContain("Support");
  expect(html).toContain("not a live chat");
  expect(html).toContain('aria-label="Support conversation"');
  expect(html).toContain('aria-label="Message to support"');
  expect(html).toContain("Send");
});

it("drops an untrusted context path", async () => {
  const html = renderToStaticMarkup(await SupportPage({
    searchParams: Promise.resolve({ from: "https://evil.test/private" }),
  }));
  expect(html).not.toContain("evil.test");
});
