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

  it("parses a ref_ payload", () => {
    expect(parseStartPayload("/start ref_ABCD1234")).toEqual({
      kind: "ref",
      code: "ABCD1234",
    });
  });

  it("parses a campaign tag and lowercases it", () => {
    expect(parseStartPayload("/start src_TG_ClippersChat")).toEqual({
      kind: "src",
      code: "tg_clipperschat",
    });
  });

  it("strips characters that have no business in a database key", () => {
    // The slug becomes part of a funnel_events row, so a link anyone can edit must not be able
    // to write arbitrary event names. Dots, slashes, spaces and quotes are dropped rather than
    // rejected, so a mistyped tag still records under a usable name.
    expect(parseStartPayload("/start src_tg/../drop me'\"")).toEqual({
      kind: "src",
      code: "tgdropme",
    });
  });

  it("truncates a long slug to 32 characters", () => {
    const long = "a".repeat(50);
    expect(parseStartPayload(`/start src_${long}`)).toEqual({
      kind: "src",
      code: "a".repeat(32),
    });
  });

  it("returns null when nothing survives sanitising", () => {
    expect(parseStartPayload("/start src_...")).toBeNull();
    expect(parseStartPayload("/start src_")).toBeNull();
  });
});
