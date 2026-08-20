import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => vi.fn());
const recordClipFeedbackMock = vi.hoisted(() => vi.fn());

// The web session lookup lives outside packages/shared, at the "@/lib/auth"
// alias. That alias is a Next.js/tsconfig path, not one vitest.config.ts
// defines - it does not resolve here, so it is mocked by its literal
// specifier the same way the real module is imported in route.ts.
vi.mock("@/lib/auth", () => ({ auth: authMock }));

vi.mock("@clipclap/shared", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, recordClipFeedback: recordClipFeedbackMock };
});

// Imported by relative path, not "@/app/...": the alias problem above applies
// to every "@/" specifier, including one pointing at the route file itself.
import { POST } from "../../app/api/clips/[id]/feedback/route";

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/clips/clip-1/feedback", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function params(id = "clip-1") {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "user-1" } });
  recordClipFeedbackMock.mockResolvedValue({ ok: true, verdict: "NO", reason: null });
});

describe("POST /api/clips/[id]/feedback", () => {
  it("refuses an unauthenticated caller and never reaches the service", async () => {
    authMock.mockResolvedValue(null);
    const res = await POST(postRequest({ verdict: "NO" }), params());
    expect(res.status).toBe(401);
    expect(recordClipFeedbackMock).not.toHaveBeenCalled();
  });

  // The user id must come from the session, never the body: a caller-supplied
  // id would let anyone write feedback as anyone else. This is the one
  // assertion in the file that a mutation check must actually catch.
  it("forwards a valid verdict with surface web and the session's user id", async () => {
    const res = await POST(
      postRequest({ verdict: "NO" }),
      params("clip-1")
    );
    expect(res.status).toBe(200);
    expect(recordClipFeedbackMock).toHaveBeenCalledWith({
      clipId: "clip-1",
      userId: "user-1",
      surface: "web",
      verdict: "NO",
      reason: undefined,
      note: undefined,
    });
  });

  it("drops an unknown verdict but keeps a valid note", async () => {
    const res = await POST(
      postRequest({ verdict: "MAYBE", note: "great edit" }),
      params()
    );
    expect(res.status).toBe(200);
    expect(recordClipFeedbackMock).toHaveBeenCalledWith({
      clipId: "clip-1",
      userId: "user-1",
      surface: "web",
      verdict: undefined,
      reason: undefined,
      note: "great edit",
    });
  });

  it("rejects an entirely empty body without calling the service", async () => {
    const res = await POST(postRequest({}), params());
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("EMPTY_FEEDBACK");
    expect(recordClipFeedbackMock).not.toHaveBeenCalled();
  });

  it("returns 400 rather than crashing on invalid JSON", async () => {
    const res = await POST(postRequest("not json"), params());
    expect(res.status).toBe(400);
    expect(recordClipFeedbackMock).not.toHaveBeenCalled();
  });

  it("maps a service refusal to 404", async () => {
    recordClipFeedbackMock.mockResolvedValue({ ok: false, code: "NOT_FOUND" });
    const res = await POST(postRequest({ verdict: "AS_IS" }), params());
    expect(res.status).toBe(404);
  });

  it("truncates a note longer than 2000 characters", async () => {
    const longNote = "x".repeat(2500);
    await POST(postRequest({ note: longNote }), params());
    const arg = recordClipFeedbackMock.mock.calls[0][0];
    expect(arg.note).toHaveLength(2000);
    expect(arg.note).toBe("x".repeat(2000));
  });
});
