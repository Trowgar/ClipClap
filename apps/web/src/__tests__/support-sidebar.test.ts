import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

vi.stubGlobal("React", React);

const pathname = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ usePathname: pathname, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../../components/user-nav", () => ({ UserNav: () => null }));
vi.mock("../../components/usage-bar", () => ({ UsageBar: () => null }));
vi.mock("@/lib/utils", () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(" ") }));
vi.mock("@/components/ui/separator", () => ({ Separator: () => null }));
vi.mock("@/components/logo", () => ({ Logo: () => React.createElement("span", null, "ClipClap") }));

import { SidebarContent } from "../../components/sidebar";

const props = {
  user: { name: null, email: null, avatarUrl: null },
  usage: { minutesUsed: 0, minutesLimit: 40, topUpRemaining: 0, plan: "NONE", freeTrial: null },
};

beforeEach(() => pathname.mockReturnValue("/dashboard/projects/p1"));

it("links Support with source context and an accessible unread badge", () => {
  const html = renderToStaticMarkup(React.createElement(SidebarContent, { ...props, supportUnread: 3 }));
  expect(html).toContain("Support");
  expect(html).toContain("/dashboard/support?from=%2Fdashboard%2Fprojects%2Fp1");
  expect(html).toContain('aria-label="3 unread support replies"');
});

it("does not render an unread badge at zero", () => {
  const html = renderToStaticMarkup(React.createElement(SidebarContent, { ...props, supportUnread: 0 }));
  expect(html).not.toContain("unread support replies");
});
