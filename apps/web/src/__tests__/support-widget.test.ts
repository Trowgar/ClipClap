import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

vi.stubGlobal("React", React);

const pathname = vi.hoisted(() => vi.fn());
const searchParams = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  usePathname: pathname,
  useSearchParams: searchParams,
}));
vi.mock("../../components/support-chat", () => ({ SupportChat: () => null }));

import { SupportWidget } from "../../components/support-widget";

beforeEach(() => {
  pathname.mockReturnValue("/dashboard/projects/p1");
  searchParams.mockReturnValue(new URLSearchParams());
});

it("renders a closed trigger with a capped unread count", () => {
  const html = renderToStaticMarkup(React.createElement(SupportWidget, { unread: 120 }));
  expect(html).toContain('aria-label="Open support chat"');
  expect(html).toContain("99+");
  expect(html).not.toContain('aria-label="Support chat"');
});

it("opens from the support query parameter", () => {
  searchParams.mockReturnValue(new URLSearchParams("support=open"));
  const html = renderToStaticMarkup(React.createElement(SupportWidget, { unread: 0 }));
  expect(html).toContain('aria-label="Support chat"');
  expect(html).toContain('aria-label="Close support chat"');
});
