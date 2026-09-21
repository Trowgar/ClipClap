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

import { getSupportOpenPath, SupportWidget } from "../../components/support-widget";

beforeEach(() => {
  pathname.mockReturnValue("/dashboard/projects/p1");
  searchParams.mockReturnValue(new URLSearchParams());
});

function renderWidget(unread: number) {
  return renderToStaticMarkup(React.createElement(SupportWidget, { unread }));
}

function supportTriggerClasses(html: string): string[] {
  const tag = html.match(/<button[^>]+aria-label="Open support chat[^"]*"[^>]*>/)?.[0];
  return tag?.match(/class="([^"]*)"/)?.[1].split(" ") ?? [];
}

it("renders no unread badge at zero", () => {
  const html = renderWidget(0);
  expect(html).toContain('aria-label="Open support chat"');
  expect(html).not.toContain('aria-hidden="true"');
  expect(html).not.toContain('aria-label="Support chat"');
});

it("renders a normal unread count accessibly", () => {
  const html = renderWidget(3);
  expect(html).toContain('aria-label="Open support chat, 3 unread replies"');
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain(">3<");
});

it("caps a large unread count visually", () => {
  const html = renderWidget(120);
  expect(html).toContain('aria-label="Open support chat, 120 unread replies"');
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain(">99+<");
});

it("tracks query-driven open requests across Dashboard paths", () => {
  expect(getSupportOpenPath("/dashboard/projects", "open")).toBe("/dashboard/projects");
  expect(getSupportOpenPath("/dashboard/settings", "open")).toBe("/dashboard/settings");
  expect(getSupportOpenPath("/dashboard/settings", "closed")).toBeNull();
  expect(getSupportOpenPath("/dashboard/settings", null)).toBeNull();
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
  expect(html).toContain('aria-modal="true"');
  expect(html).toContain('aria-label="Close support chat"');
  expect(html).toContain('data-active="true"');
  expect(html).toContain('data-context-path="/dashboard/projects/p1"');
});

it("hides the floating trigger only while the dialog is open", () => {
  expect(supportTriggerClasses(renderWidget(0))).not.toContain("hidden");
  searchParams.mockReturnValue(new URLSearchParams("support=open"));
  expect(supportTriggerClasses(renderWidget(0))).toContain("hidden");
});

it("clears the displayed unread count when query opening", () => {
  searchParams.mockReturnValue(new URLSearchParams("support=open"));
  const html = renderWidget(3);
  expect(html).toContain('aria-label="Open support chat"');
  expect(html).not.toContain("unread replies");
  expect(html).not.toContain(">3<");
});
