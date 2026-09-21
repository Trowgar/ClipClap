import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ createMany: vi.fn(), upsert: vi.fn() }));
vi.mock("../../lib/prisma", () => ({ prisma: {
  conversionEvent: { createMany: mock.createMany }, funnelEvent: { upsert: mock.upsert },
} }));
import { recordConversionEvent, recordFunnelEvent } from "../funnel.service";
beforeEach(() => { vi.clearAllMocks(); });
it("keeps separate timestamped actions and deduplicates a provider event by its key", async () => {
  await recordConversionEvent("web", "u", "offer_clicked", { durationSec: 5520 });
  await recordConversionEvent("web", "u", "payment_succeeded", { provider: "stripe" }, "stripe:checkout:cs_1");
  expect(mock.createMany).toHaveBeenCalledTimes(2);
  expect(mock.createMany.mock.calls[1][0]).toMatchObject({
    data: { surface: "web", subjectId: "u", event: "payment_succeeded", eventKey: "stripe:checkout:cs_1" }, skipDuplicates: true,
  });
});
it("keeps checkout lifetime counters separate from provider-ID conversion events", async () => {
  await recordFunnelEvent("bot", "42", "checkout_started");
  expect(mock.upsert).toHaveBeenCalledOnce();
  expect(mock.createMany).not.toHaveBeenCalled();
});
it("does not mistake a claimed bot offer for a successfully sent message", async () => {
  await recordFunnelEvent("bot", "42", "post_clip_offer_starter");
  expect(mock.createMany).not.toHaveBeenCalled();
});
it("does not break a payment or user request when telemetry storage fails", async () => {
  mock.createMany.mockRejectedValueOnce(new Error("offline"));
  vi.spyOn(console, "warn").mockImplementationOnce(() => {});
  await expect(recordConversionEvent("web", "u", "payment_succeeded")).resolves.toBeUndefined();
});
