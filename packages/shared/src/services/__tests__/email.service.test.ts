import { describe, it, expect } from "vitest";
import { escapeHtml, layout } from "../email.service";

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

/** Testing escapeHtml alone proves nothing about the mail we actually send: a
 *  mutation run dropped the escaping from layout's body and href interpolations
 *  and every test above stayed green. The security boundary is the call site,
 *  so these assert the applied result. */
describe("layout", () => {
  const ok = { href: "https://clipclap.io/a", label: "Go" };

  it("escapes the heading and the body", () => {
    const html = layout("<b>hi", "<img src=x onerror=alert(1)>", ok);
    expect(html).toContain("&lt;b&gt;hi");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
  });

  it("escapes the button label", () => {
    expect(layout("h", "b", { ...ok, label: "<i>go" })).toContain("&lt;i&gt;go");
  });

  // Two query parameters are the ordinary case, not an edge one - a bare "&"
  // in an attribute value is malformed HTML that mail clients then repair by
  // guessing.
  it("writes an ampersand in the href as an entity", () => {
    const html = layout("h", "b", {
      ...ok,
      href: "https://clipclap.io/reset?token=abc&next=/dashboard",
    });
    expect(html).toContain("token=abc&amp;next=/dashboard");
  });

  it("cannot be broken out of the href attribute", () => {
    const html = layout("h", "b", {
      ...ok,
      href: `https://clipclap.io/a" onclick="alert(1)`,
    });
    expect(html).not.toContain(`onclick="alert(1)"`);
    expect(html).toContain("%22");
  });

  it("refuses a javascript: link outright", () => {
    // Escaping renders this harmlessly as text but leaves it live as an href,
    // so the scheme has to be rejected rather than encoded.
    expect(() =>
      layout("h", "b", { href: "javascript:alert(1)", label: "Go" })
    ).toThrow(/non-http/);
  });

  it("allows plain http, because dev runs on localhost", () => {
    expect(() =>
      layout("h", "b", { href: "http://localhost:3000/a", label: "Go" })
    ).not.toThrow();
  });
});
