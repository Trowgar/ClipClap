import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), list: vi.fn(), unread: vi.fn(), submit: vi.fn(), read: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@clipclap/shared", () => ({
  SupportRateLimitError: class SupportRateLimitError extends Error {},
  listWebSupportMessages: mocks.list,
  countUnreadWebSupport: mocks.unread,
  submitWebSupportMessage: mocks.submit,
  markWebSupportRead: mocks.read,
}));

import { GET, POST } from "../../app/api/support/route";
import { POST as READ } from "../../app/api/support/read/route";
import { SupportRateLimitError } from "@clipclap/shared";

const validId = "12345678-1234-4234-8234-123456789abc";
const request = (body: unknown) => new NextRequest("https://clipclap.io/api/support", {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "u1" } });
  mocks.list.mockResolvedValue([{ id: "m1", text: "Hi", direction: "in" }]);
  mocks.unread.mockResolvedValue(1);
  mocks.submit.mockResolvedValue({ id: "m1", text: "help", deliveryStatus: "sent" });
  mocks.read.mockResolvedValue(1);
});

it("requires authentication on read, send and mark-read", async () => {
  mocks.auth.mockResolvedValue(null);
  expect((await GET()).status).toBe(401);
  expect((await POST(request({ text: "help", clientMessageId: validId }))).status).toBe(401);
  expect((await READ()).status).toBe(401);
});

it("returns only the authenticated user's thread and unread count", async () => {
  const response = await GET();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ messages: [{ id: "m1", text: "Hi", direction: "in" }], unread: 1 });
  expect(mocks.list).toHaveBeenCalledWith("u1");
  expect(mocks.unread).toHaveBeenCalledWith("u1");
});

it.each([
  [{ text: " ", clientMessageId: validId }, "empty text"],
  [{ text: "x".repeat(4001), clientMessageId: validId }, "long text"],
  [{ text: "help", clientMessageId: "not-a-uuid" }, "bad id"],
  [{ text: "help", clientMessageId: validId, contextPath: "https://evil.test" }, "external context"],
  [{ text: "help", clientMessageId: validId, contextPath: "/admin" }, "non-dashboard context"],
])("rejects invalid input: %s", async (body) => {
  expect((await POST(request(body))).status).toBe(400);
  expect(mocks.submit).not.toHaveBeenCalled();
});

it("passes only validated values and authenticated identity", async () => {
  const response = await POST(request({
    text: "  help me  ", clientMessageId: validId,
    contextPath: "/dashboard/projects/p1", userId: "victim", direction: "out",
  }));
  expect(response.status).toBe(200);
  expect(mocks.submit).toHaveBeenCalledWith({
    userId: "u1", text: "help me", clientMessageId: validId,
    contextPath: "/dashboard/projects/p1",
  });
});

it("maps the support rate limit to 429", async () => {
  mocks.submit.mockRejectedValue(new SupportRateLimitError("wait"));
  const response = await POST(request({ text: "help", clientMessageId: validId }));
  expect(response.status).toBe(429);
});

it("marks only the signed-in user's replies read", async () => {
  const response = await READ();
  expect(response.status).toBe(204);
  expect(mocks.read).toHaveBeenCalledWith("u1");
});

it("rejects an oversized request before parsing JSON", async () => {
  const response = await POST(new NextRequest("https://clipclap.io/api/support", {
    method: "POST", body: "x".repeat(8193),
  }));
  expect(response.status).toBe(413);
});
