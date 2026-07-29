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
  const base = {
    preheader: "snippet",
    heading: "h",
    body: "b",
    cta: { href: "https://clipclap.io/a", label: "Go" },
    expiry: "one hour",
  };

  it("escapes the heading and the body", () => {
    const html = layout({
      ...base,
      heading: "<b>hi",
      body: "<img src=x onerror=alert(1)>",
    });
    expect(html).toContain("&lt;b&gt;hi");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
  });

  it("escapes the button label", () => {
    expect(
      layout({ ...base, cta: { ...base.cta, label: "<i>go" } })
    ).toContain("&lt;i&gt;go");
  });

  // The preheader and the expiry line are interpolated too, and the preheader
  // is the one field a future caller is most likely to build from user input,
  // because it is the sentence shown in the inbox list.
  it("escapes the preheader and the expiry line", () => {
    const html = layout({
      ...base,
      preheader: "<script>alert(1)</script>",
      expiry: "<b>soon",
    });
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;soon");
    expect(html).not.toContain("<script>");
  });

  // Two query parameters are the ordinary case, not an edge one - a bare "&"
  // in an attribute value is malformed HTML that mail clients then repair by
  // guessing.
  it("writes an ampersand in the href as an entity", () => {
    const html = layout({
      ...base,
      cta: {
        ...base.cta,
        href: "https://clipclap.io/reset?token=abc&next=/dashboard",
      },
    });
    expect(html).toContain("token=abc&amp;next=/dashboard");
  });

  it("cannot be broken out of the href attribute", () => {
    const html = layout({
      ...base,
      cta: { ...base.cta, href: `https://clipclap.io/a" onclick="alert(1)` },
    });
    expect(html).not.toContain(`onclick="alert(1)"`);
    expect(html).toContain("%22");
  });

  it("refuses a javascript: link outright", () => {
    // Escaping renders this harmlessly as text but leaves it live as an href,
    // so the scheme has to be rejected rather than encoded.
    expect(() =>
      layout({ ...base, cta: { href: "javascript:alert(1)", label: "Go" } })
    ).toThrow(/non-http/);
  });

  it("allows plain http, because dev runs on localhost", () => {
    expect(() =>
      layout({ ...base, cta: { href: "http://localhost:3000/a", label: "Go" } })
    ).not.toThrow();
  });

  // The link has to be recoverable when the button is stripped - corporate
  // scanners rewrite anchors, and a token URL that does not wrap breaks the
  // card open on a phone.
  it("prints the url as copyable text as well as a button", () => {
    const href = `https://clipclap.io/api/auth/verify?token=${"a".repeat(64)}`;
    const html = layout({ ...base, cta: { href, label: "Go" } });
    const occurrences = html.split(href).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(html).toContain("word-break:break-all");
  });

  // Before the <h1>, not merely before the heading text - the heading also
  // appears in <title>, which sits in the head and proves nothing about the
  // order the client reads for its snippet.
  it("carries a preheader before any visible copy", () => {
    const html = layout({ ...base, preheader: "the snippet" });
    expect(html.indexOf("the snippet")).toBeLessThan(html.indexOf("<h1"));
    expect(html).toContain("max-height:0");
  });

  // Word ignores border-radius and collapses a padded anchor, so without the
  // VML fallback the primary action degrades to a bare underlined link.
  it("ships an mso fallback for the button", () => {
    const html = layout(base);
    expect(html).toContain("v:roundrect");
    expect(html).toContain("<!--[if mso]>");
  });
});
