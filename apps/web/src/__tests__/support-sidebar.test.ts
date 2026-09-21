import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

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

it("does not include Support navigation", () => {
  pathname.mockReturnValue("/dashboard/projects/p1");
  const html = renderToStaticMarkup(React.createElement(SidebarContent, { ...props, supportUnread: 3 }));
  expect(html).toContain('href="/dashboard"');
  expect(html).toContain(">Home<");
  expect(html).toContain('href="/dashboard/settings"');
  expect(html).toContain(">Settings<");
  expect(html).not.toContain("Support");
  expect(html).not.toContain("/dashboard/support");
});
