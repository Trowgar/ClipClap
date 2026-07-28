import { describe, it, expect } from "vitest";
import { escapeHtml } from "../email.service";

/** Fix 5 replaced a "callers must be careful" comment with escaping done by
 *  construction. These tests are what actually holds that in place. */
describe("escapeHtml", () => {
  it("neutralises a script tag", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;"
    );
  });

  it("escapes ampersands first, so entities are not double-escaped", () => {
    // "&lt;" arriving as literal text must survive as displayable text, not
    // decode back into a tag in the recipient's mail client.
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("escapes both quote styles, so a value cannot break out of an attribute", () => {
    expect(escapeHtml(`" onmouseover='x`)).toBe(
      "&quot; onmouseover=&#39;x"
    );
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeHtml("Confirm your email")).toBe("Confirm your email");
  });
});
