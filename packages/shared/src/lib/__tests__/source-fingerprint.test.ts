import { describe, expect, it } from "vitest";
import {
  normalizeSourceUrl,
  telegramSourceFingerprint,
  urlSourceFingerprint,
} from "../source-fingerprint";

describe("normalizeSourceUrl", () => {
  // The whole point: every share button's spelling of one YouTube upload is
  // ONE string. These are the forms real users pasted.
  it.each([
    "https://youtu.be/dQw4w9WgXcQ?si=2zr6z6hYKwmnSo91",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ?feature=share",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    "  https://youtube.com/watch?v=dQw4w9WgXcQ#t=10  ",
    "HTTPS://YOUTU.BE/dQw4w9WgXcQ",
  ])("collapses %s to the canonical watch URL", (url) => {
    expect(normalizeSourceUrl(url)).toBe("https://youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("keeps different YouTube ids apart", () => {
    expect(normalizeSourceUrl("https://youtu.be/dQw4w9WgXcQ")).not.toBe(
      normalizeSourceUrl("https://youtu.be/dQw4w9WgXcR")
    );
  });

  // Not YouTube: host + path survive, noise params go, the rest is sorted so
  // param order cannot split one video into two keys.
  it("strips tracking params and sorts the rest for other hosts", () => {
    expect(
      normalizeSourceUrl("https://www.tiktok.com/@user/video/7106594312292453675?_r=1&utm_source=x&is_from_webapp=1")
    ).toBe("https://tiktok.com/@user/video/7106594312292453675?is_from_webapp=1");
    expect(normalizeSourceUrl("https://example.com/v?b=2&a=1&fbclid=zzz")).toBe(
      "https://example.com/v?a=1&b=2"
    );
  });

  it("ignores hash, trailing slash and www.", () => {
    expect(normalizeSourceUrl("https://www.twitch.tv/videos/123/#top")).toBe(
      "https://twitch.tv/videos/123"
    );
    expect(normalizeSourceUrl("https://twitch.tv/videos/123")).toBe(
      "https://twitch.tv/videos/123"
    );
  });

  // A param not on the noise list is meaningful until proven otherwise - an
  // unknown one must never be stripped.
  it("keeps params it does not recognise", () => {
    expect(normalizeSourceUrl("https://vimeo.com/123?h=abcdef")).toBe(
      "https://vimeo.com/123?h=abcdef"
    );
  });

  it("returns null for non-URLs and non-http schemes", () => {
    expect(normalizeSourceUrl("not a url")).toBeNull();
    expect(normalizeSourceUrl("")).toBeNull();
    expect(normalizeSourceUrl("ftp://example.com/x")).toBeNull();
    expect(normalizeSourceUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("fingerprints", () => {
  it("prefixes the two kinds so they can never collide", () => {
    expect(urlSourceFingerprint("https://youtu.be/dQw4w9WgXcQ?si=1")).toBe(
      "url:https://youtube.com/watch?v=dQw4w9WgXcQ"
    );
    expect(telegramSourceFingerprint("AgADxyz")).toBe("tg:AgADxyz");
    expect(urlSourceFingerprint("nope")).toBeNull();
  });
});
