import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => vi.fn());
const findFirstMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({ auth: authMock }));

vi.mock("@clipclap/shared", () => ({
  prisma: { job: { findFirst: findFirstMock } },
  parseJobErrorCode: vi.fn(),
}));

import { GET } from "../../app/api/jobs/[id]/stream/route";

function params(id = "job-1") {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/jobs/[id]/stream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-1" } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops polling when the client cancels the stream", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/jobs/job-1/stream"),
      params(),
    );

    await response.body?.cancel();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(findFirstMock).not.toHaveBeenCalled();
  });
});
