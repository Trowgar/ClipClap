import { describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: class {
      send = sendMock;
    },
  };
});

import { getObjectSize } from "../r2";

describe("getObjectSize", () => {
  it("returns the byte count from ContentLength", async () => {
    sendMock.mockResolvedValueOnce({ ContentLength: 20557490 });
    await expect(getObjectSize("clips/a/b.mp4")).resolves.toBe(20557490);
  });

  // A HEAD that answers without a length is not "zero bytes" - treating it as 0
  // would wave an unmeasured file straight past the size gate.
  it("returns null when the store gives no length", async () => {
    sendMock.mockResolvedValueOnce({});
    await expect(getObjectSize("clips/a/b.mp4")).resolves.toBeNull();
  });
});
