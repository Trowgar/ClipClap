import { describe, expect, it } from "vitest";
import { parseStartPayload } from "../handlers";

describe("parseStartPayload", () => {
  it("returns null for plain /start", () => {
    expect(parseStartPayload("/start")).toBeNull();
  });

  it("returns null for unknown payload", () => {
    expect(parseStartPayload("/start hello")).toBeNull();
  });

  it("extracts the link code from /start link_<code>", () => {
    expect(parseStartPayload("/start link_ABC123")).toEqual({
      kind: "link",
      code: "ABC123",
    });
  });

  it("strips the bot mention before parsing", () => {
    expect(parseStartPayload("/start@clipclapbot link_XYZ789")).toEqual({
      kind: "link",
      code: "XYZ789",
    });
  });

  it("returns null when the link prefix has no code", () => {
    expect(parseStartPayload("/start link_")).toBeNull();
  });
});
