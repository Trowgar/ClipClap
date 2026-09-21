import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), getClip: vi.fn(), editClip: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@clipclap/shared", () => ({ clipService: { ...mocks, ClipEditError: class extends Error {} } }));
import { PUT } from "../../app/api/clips/[id]/edit/route";
import { clipService } from "@clipclap/shared";
const send = (body: unknown) => PUT(new NextRequest("http://localhost/api/clips/c/edit", { method: "PUT", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "c" }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "owner" } });
  mocks.getClip.mockResolvedValue({ startTime: 40, endTime: 60 });
  mocks.editClip.mockResolvedValue({ id: "new" });
});

it("passes only authenticated ownership and explicit source repair options", async () => {
  expect((await send({ userId: "attacker", extendEndSeconds: 5, framing: "safe-fit" })).status).toBe(201);
  expect(mocks.editClip).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner", clipId: "c", start: 40, end: 60, extendEndSeconds: 5, framing: "safe-fit" }));
});

it.each([null, [], { trim: { start: -Infinity } }, { extendEndSeconds: 20 }, { framing: "other" }, { subtitles: "yes" }, { subtitleTrack: { cues: [null] } }])("rejects malformed request %j", async body => {
  // JSON cannot represent infinity; its null encoding must not authorize it.
  const response = await send(body);
  expect(response.status).toBe(400);
  expect(mocks.editClip).not.toHaveBeenCalled();
});

it("returns actionable source errors without claiming the repair succeeded", async () => {
  mocks.editClip.mockRejectedValue(new clipService.ClipEditError("Original unavailable"));
  const response = await send({ extendEndSeconds: 2 });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Original unavailable" });
});

it("does not edit another user's clip", async () => {
  mocks.getClip.mockResolvedValue(null);
  expect((await send({ extendEndSeconds: 2 })).status).toBe(404);
  expect(mocks.editClip).not.toHaveBeenCalled();
});
