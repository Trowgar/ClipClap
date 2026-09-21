import { expect, it } from "vitest";
import { getUploadLimit } from "../../lib/upload-limits";
it("compares the same seconds as the server and separates quota from source cap", () => {
  expect(getUploadLimit(1742, 1755, 2400)).toBeNull();
  expect(getUploadLimit(1755, 1755, 2400)).toBeNull();
  expect(getUploadLimit(1756, 1755, 2400)).toBe("QUOTA");
  expect(getUploadLimit(5520, 2400, 2400)).toBe("TOO_LONG");
  expect(getUploadLimit(null, 2400, 2400)).toBeNull();
});
