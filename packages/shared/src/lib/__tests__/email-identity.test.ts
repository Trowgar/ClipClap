import { describe, it, expect } from "vitest";
import { canonicalizeEmail, isDisposableEmail } from "../email-identity";

describe("canonicalizeEmail", () => {
  it("lowercases and trims any address", () => {
    expect(canonicalizeEmail("  Oleg@Example.COM ")).toBe("oleg@example.com");
  });

  it("strips dots and +suffix for gmail", () => {
    expect(canonicalizeEmail("o.l.e.g+clipclap@gmail.com")).toBe("oleg@gmail.com");
  });

  it("folds googlemail onto gmail", () => {
    expect(canonicalizeEmail("oleg@googlemail.com")).toBe("oleg@gmail.com");
  });

  // Dots are significant almost everywhere else; folding them would merge two
  // different people into one account.
  it("keeps dots for non-gmail domains", () => {
    expect(canonicalizeEmail("o.leg@yahoo.com")).toBe("o.leg@yahoo.com");
  });

  it("still strips +suffix outside gmail", () => {
    expect(canonicalizeEmail("oleg+spam@yahoo.com")).toBe("oleg@yahoo.com");
  });

  it("returns null for something that is not an address", () => {
    expect(canonicalizeEmail("not-an-email")).toBeNull();
    expect(canonicalizeEmail("a@b@c.com")).toBeNull();
    expect(canonicalizeEmail("")).toBeNull();
  });

  // A trailing dot is legal FQDN notation and receiving servers treat it as the
  // same mailbox, so it must not mint a second canonical identity.
  it("ignores a trailing dot on the domain", () => {
    expect(canonicalizeEmail("oleg@gmail.com.")).toBe("oleg@gmail.com");
    expect(canonicalizeEmail("o.leg@yahoo.com.")).toBe("o.leg@yahoo.com");
  });

  it("still rejects a domain that is only dots", () => {
    expect(canonicalizeEmail("a@.")).toBeNull();
    expect(canonicalizeEmail("a@com.")).toBeNull();
  });
});

describe("isDisposableEmail", () => {
  it("flags a known throwaway domain", () => {
    expect(isDisposableEmail("someone@mailinator.com")).toBe(true);
  });

  it("flags a subdomain of a known throwaway domain", () => {
    expect(isDisposableEmail("someone@inbox.mailinator.com")).toBe(true);
  });

  it("passes an ordinary domain", () => {
    expect(isDisposableEmail("someone@gmail.com")).toBe(false);
  });

  it("treats an unparseable address as not disposable", () => {
    expect(isDisposableEmail("nonsense")).toBe(false);
  });
});
