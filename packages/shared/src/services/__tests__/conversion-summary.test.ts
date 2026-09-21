import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ users: vi.fn(), events: vi.fn() }));
vi.mock("../../lib/prisma", () => ({ prisma: { user: { findMany: mocks.users }, conversionEvent: { findMany: mocks.events } } }));
import { getConversionSummary } from "../conversion-summary.service";
it("counts external people once across surfaces, not every action, and keeps synthetic events out", async () => {
  mocks.users.mockResolvedValue([{ id: "u", telegramId: "42" }]);
  mocks.events.mockResolvedValue([
    { surface: "web", subjectId: "u", event: "payment_succeeded" },
    { surface: "bot", subjectId: "42", event: "payment_succeeded" },
    { surface: "web", subjectId: "synthetic", event: "payment_succeeded" },
  ]);
  const { rows } = await getConversionSummary(undefined, "owner@example.test");
  expect(rows.find(x => x.event === "payment_succeeded")).toEqual({ event: "payment_succeeded", actions: 2, users: 1 });
  expect(mocks.users.mock.calls[0][0].where).toMatchObject({ isSynthetic: false });
});
it("counts ordered people from an offer cohort and distinct provider checkout IDs", async () => {
  mocks.users.mockResolvedValue([{ id: "u", telegramId: "42" }, { id: "v", telegramId: null }]);
  mocks.events.mockResolvedValue([
    ["u", "payment_succeeded", 0, {}],
    ["u", "offer_shown", 1, {}],
    ["u", "offer_clicked", 2, {}],
    ["u", "checkout_started", 3, {provider:"stripe",sessionId:"cs_1"}],
    ["u", "checkout_started", 4, {provider:"stripe",sessionId:"cs_1"}],
    ["u", "payment_succeeded", 5, {}],
    ["u", "paid_job_succeeded", 6, {}],
    ["v", "paid_job_succeeded", 0, {}],
    ["v", "offer_shown", 1, {}],
  ].map(([subjectId,event,time,detail]) => ({surface:"web",subjectId,event,createdAt:new Date(Number(time)*1000),detail})));
  const summary = await getConversionSummary();
  expect(summary.checkoutSessions).toBe(1);
  expect(summary.cohort.map(x => x.users)).toEqual([2,1,1,1,1]);
});
