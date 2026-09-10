import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = resolve(process.cwd(), "apps/web");
const loginSource = readFileSync(
  resolve(appRoot, "app/(auth)/login/login-form.tsx"),
  "utf8",
);
const nextConfig = readFileSync(resolve(appRoot, "next.config.ts"), "utf8");

describe("login account privacy", () => {
  it("does not query a public account-existence endpoint", () => {
    expect(loginSource).not.toContain("/api/auth/check-email");
    expect(
      existsSync(resolve(appRoot, "app/api/auth/check-email/route.ts")),
    ).toBe(false);
  });

  it("lets the visitor explicitly choose registration", () => {
    expect(loginSource).toContain('setStep("register")');
    expect(loginSource).toContain("Create account instead");
  });

  it("keeps Server Action request bodies small", () => {
    expect(nextConfig).toContain('bodySizeLimit: "1mb"');
    expect(nextConfig).not.toContain('bodySizeLimit: "5gb"');
  });
});
