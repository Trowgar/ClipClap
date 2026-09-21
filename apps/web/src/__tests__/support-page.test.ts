import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const redirect = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ redirect, useRouter: () => ({ refresh: vi.fn() }) }));
vi.stubGlobal("React", React);

import SupportPage from "../../app/(dashboard)/dashboard/support/page";
import { mergeSupportMessages, SupportChat } from "../../components/support-chat";

it("redirects the legacy support page to the widget", async () => {
  await SupportPage();
  expect(redirect).toHaveBeenCalledWith("/dashboard?support=open");
});

it("merges an optimistic row with its server row by client message ID", () => {
  const createdAt = new Date().toISOString();
  const optimistic = {
    id: "pending:message-uuid", direction: "in" as const, text: "help",
    deliveryStatus: "pending" as const, dedupeKey: "web:pending:message-uuid", createdAt,
  };
  const server = {
    ...optimistic, id: "db-row", deliveryStatus: "sent" as const,
    dedupeKey: "web:user-id:message-uuid",
  };
  expect(mergeSupportMessages([server], [optimistic])).toEqual([server]);
});

it("merges an embedding class into the support chat section", () => {
  const html = renderToStaticMarkup(
    React.createElement(SupportChat, { active: false, className: "widget-chat" })
  );
  expect(html).toContain("widget-chat");
  expect(html).toContain("min-h-[32rem]");
});

it("stacks a fixed textarea above a full-width send button", () => {
  const html = renderToStaticMarkup(
    React.createElement(SupportChat, { active: false })
  );
  expect(html).toContain('class="block h-20 w-full resize-none');
  expect(html).toContain('class="flex h-10 w-full items-center justify-center');
  expect(html).toContain("Ctrl/⌘ + Enter to send");
});
