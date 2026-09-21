import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), count: vi.fn(), record: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@clipclap/shared", () => ({ prisma: { conversionEvent: { count: mocks.count } }, recordConversionEvent: mocks.record }));
import { POST } from "../../app/api/conversion/route";
const request = (event: string, detail = {}) => new NextRequest("https://clipclap.io/api/conversion", {
  method: "POST", body: JSON.stringify({ event, eventId: "12345678-1234-1234-1234-123456789abc", subjectId: "victim", detail }),
});
beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ user: { id: "u" } }); mocks.count.mockResolvedValue(0); });
it("attributes browser events to the authenticated user and strips private/unrecognised fields", async () => {
  expect((await POST(request("offer_shown", { durationSec: 5520, email: "private", url: "private" }))).status).toBe(204);
  expect(mocks.record).toHaveBeenCalledWith("web", "u", "offer_shown", { durationSec: 5520 }, "browser:u:12345678-1234-1234-1234-123456789abc");
});
it("does not let the browser forge confirmed payments", async () => {
  expect((await POST(request("payment_succeeded"))).status).toBe(400);
  expect(mocks.record).not.toHaveBeenCalled();
});
it("requires login and bounds event volume", async () => {
  mocks.auth.mockResolvedValueOnce(null);
  expect((await POST(request("offer_clicked"))).status).toBe(401);
  mocks.count.mockResolvedValueOnce(60);
  expect((await POST(request("offer_clicked"))).status).toBe(429);
  expect(mocks.record).not.toHaveBeenCalled();
});
