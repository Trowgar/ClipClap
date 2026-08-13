import { describe, expect, it } from "vitest";
import { isolate } from "../i18n/bidi";

const FSI = "\u2068";
const PDI = "\u2069";

describe("isolate", () => {
  it("wraps a value in first-strong-isolate and pop-directional-isolate", () => {
    expect(isolate("https://clipclap.io")).toBe(`${FSI}https://clipclap.io${PDI}`);
  });

  it("accepts numbers, which is most of what gets interpolated", () => {
    expect(isolate(5)).toBe(`${FSI}5${PDI}`);
  });

  // An empty isolate is invisible padding around nothing. Returning the empty
  // string keeps a message from carrying two stray control characters when an
  // optional value is absent.
  it("returns an empty string unchanged", () => {
    expect(isolate("")).toBe("");
  });

  // Nesting would leave unbalanced pairs if a caller isolates an already
  // isolated value, and unbalanced bidi controls corrupt everything after
  // them in the paragraph.
  it("does not nest an already isolated value", () => {
    expect(isolate(isolate("STARTER"))).toBe(`${FSI}STARTER${PDI}`);
  });
});
