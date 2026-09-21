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
vi.mock("../../components/support-chat", () => ({
  SupportChat: ({ active, contextPath }: { active?: boolean; contextPath?: string }) =>
    React.createElement("div", {
      "data-active": String(active),
      "data-context-path": contextPath,
    }),
}));

import { SupportWidget } from "../../components/support-widget";

beforeEach(() => {
  pathname.mockReturnValue("/dashboard/projects/p1");
  searchParams.mockReturnValue(new URLSearchParams());
});

function renderWidget(unread: number) {
  return renderToStaticMarkup(React.createElement(SupportWidget, { unread }));
}

it("renders no unread badge at zero", () => {
  const html = renderWidget(0);
  expect(html).toContain('aria-label="Open support chat"');
  expect(html).not.toContain("unread support replies");
  expect(html).not.toContain('aria-label="Support chat"');
});

it("renders a normal unread count accessibly", () => {
  const html = renderWidget(3);
  expect(html).toContain('aria-label="3 unread support replies"');
  expect(html).toContain(">3<");
});

it("caps a large unread count visually", () => {
  const html = renderWidget(120);
  expect(html).toContain('aria-label="120 unread support replies"');
  expect(html).toContain(">99+<");
});

it("stays closed for an unrelated query parameter", () => {
  searchParams.mockReturnValue(new URLSearchParams("tab=projects"));
  const html = renderWidget(0);
  expect(html).toContain('aria-label="Open support chat"');
  expect(html).not.toContain('aria-label="Support chat"');
});

it("opens from the support query parameter", () => {
  searchParams.mockReturnValue(new URLSearchParams("support=open"));
  const html = renderWidget(0);
  expect(html).toContain('aria-label="Support chat"');
  expect(html).toContain('aria-label="Close support chat"');
  expect(html).toContain('data-active="true"');
  expect(html).toContain('data-context-path="/dashboard/projects/p1"');
});
