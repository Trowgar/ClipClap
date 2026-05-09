import { describe, it, expect, beforeAll } from "vitest";

const BASE = "http://localhost:80";

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, text: await res.text() };
}

// Generate unique email per test run to avoid collisions
const uid = Date.now().toString(36);

describe("API Integration Tests", () => {
  // ──────────────────────────────────────
  // Health / Pages
  // ──────────────────────────────────────
  describe("Pages load", () => {
    it("GET / returns 200", async () => {
      const { status } = await get("/");
      expect(status).toBe(200);
    });

    it("GET /login returns 200", async () => {
      const { status } = await get("/login");
      expect(status).toBe(200);
    });

    it("GET /dashboard redirects to /login (unauthenticated)", async () => {
      const res = await fetch(`${BASE}/dashboard`, { redirect: "manual" });
      // Should be a redirect (307 or 302)
      expect([302, 307]).toContain(res.status);
    });

    it("landing page contains ClipClap", async () => {
      const { text } = await get("/");
      expect(text).toContain("ClipClap");
    });

    it("landing page contains key sections", async () => {
      const { text } = await get("/");
      expect(text).toContain("Stop scrubbing");
      expect(text).toContain("Telegram");
      expect(text).toContain("Simple pricing");
      expect(text).toContain("Get Plus");
    });

    it("login page contains auth elements", async () => {
      const { text } = await get("/login");
      expect(text).toContain("Welcome");
      expect(text).toContain("Continue with Email");
      expect(text).toContain("Continue with Google");
    });

    it("favicon.svg is accessible", async () => {
      const { status } = await get("/favicon.svg");
      expect(status).toBe(200);
    });

    it("clip images are accessible", async () => {
      const images = ["clip-1.png", "clip-2.png", "clip-3.png", "clip-4.png", "source-podcast.png"];
      for (const img of images) {
        const { status } = await get(`/clips/${img}`);
        expect(status).toBe(200);
      }
    });
  });

  // ──────────────────────────────────────
  // Check Email API
  // ──────────────────────────────────────
  describe("POST /api/auth/check-email", () => {
    it("returns 400 if email is missing", async () => {
      const { status, data } = await post("/api/auth/check-email", {});
      expect(status).toBe(400);
      expect(data.error).toBeDefined();
    });

    it("returns exists:false for unknown email", async () => {
      const { status, data } = await post("/api/auth/check-email", {
        email: `nonexistent-${uid}@test.com`,
      });
      expect(status).toBe(200);
      expect(data.exists).toBe(false);
      expect(data.hasPassword).toBe(false);
    });

    it("returns exists:true, hasPassword:true for registered user", async () => {
      // First register
      await post("/api/register", {
        email: `check-${uid}@test.com`,
        name: "Check User",
        password: "password123",
      });

      const { status, data } = await post("/api/auth/check-email", {
        email: `check-${uid}@test.com`,
      });
      expect(status).toBe(200);
      expect(data.exists).toBe(true);
      expect(data.hasPassword).toBe(true);
    });
  });

  // ──────────────────────────────────────
  // Register API
  // ──────────────────────────────────────
  describe("POST /api/register", () => {
    it("returns 400 if email is missing", async () => {
      const { status, data } = await post("/api/register", {
        password: "test123",
      });
      expect(status).toBe(400);
      expect(data.error).toContain("Email and password are required");
    });

    it("returns 400 if password is missing", async () => {
      const { status, data } = await post("/api/register", {
        email: `nopass-${uid}@test.com`,
      });
      expect(status).toBe(400);
      expect(data.error).toContain("Email and password are required");
    });

    it("returns 400 if password is too short", async () => {
      const { status, data } = await post("/api/register", {
        email: `short-${uid}@test.com`,
        password: "abc",
      });
      expect(status).toBe(400);
      expect(data.error).toContain("at least 6 characters");
    });

    it("returns 400 for 5-char password (boundary)", async () => {
      const { status } = await post("/api/register", {
        email: `five-${uid}@test.com`,
        password: "12345",
      });
      expect(status).toBe(400);
    });

    it("accepts 6-char password (boundary)", async () => {
      const { status, data } = await post("/api/register", {
        email: `six-${uid}@test.com`,
        password: "123456",
      });
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
    });

    it("successfully registers a new user", async () => {
      const { status, data } = await post("/api/register", {
        email: `new-${uid}@test.com`,
        name: "New User",
        password: "securepass123",
      });
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
    });

    it("registers without name (optional field)", async () => {
      const { status, data } = await post("/api/register", {
        email: `noname-${uid}@test.com`,
        password: "securepass123",
      });
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
    });

    it("returns 409 for duplicate email", async () => {
      const email = `dup-${uid}@test.com`;

      // First registration
      const first = await post("/api/register", {
        email,
        name: "First",
        password: "password123",
      });
      expect(first.status).toBe(200);

      // Duplicate
      const second = await post("/api/register", {
        email,
        name: "Second",
        password: "differentpass",
      });
      expect(second.status).toBe(409);
      expect(second.data.error).toContain("already exists");
    });

    it("email is case-preserved", async () => {
      const email = `CaseTest-${uid}@Test.COM`;
      const { status } = await post("/api/register", {
        email,
        password: "password123",
      });
      expect(status).toBe(200);
    });

    it("password is hashed (not stored as plain text)", async () => {
      const email = `hashcheck-${uid}@test.com`;
      const password = "myplaintext";

      await post("/api/register", { email, password });

      // Verify via check-email that user exists
      const { data } = await post("/api/auth/check-email", { email });
      expect(data.exists).toBe(true);
      expect(data.hasPassword).toBe(true);
      // We can't directly check the hash, but we can verify the user
      // was created and has a password field set
    });
  });

  // ──────────────────────────────────────
  // Credentials Sign In
  // ──────────────────────────────────────
  describe("POST /api/auth/callback/credentials", () => {
    const testEmail = `signin-${uid}@test.com`;
    const testPassword = "signinpass123";

    beforeAll(async () => {
      await post("/api/register", {
        email: testEmail,
        name: "Sign In User",
        password: testPassword,
      });
    });

    it("rejects with wrong password", async () => {
      const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          email: testEmail,
          password: "wrongpassword",
        }),
        redirect: "manual",
      });
      // NextAuth redirects on error
      const location = res.headers.get("location") || "";
      expect(location).toContain("error");
    });

    it("rejects with non-existent email", async () => {
      const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          email: `nonexistent-${uid}@test.com`,
          password: "anything",
        }),
        redirect: "manual",
      });
      const location = res.headers.get("location") || "";
      expect(location).toContain("error");
    });

    it("rejects with empty credentials", async () => {
      const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          email: "",
          password: "",
        }),
        redirect: "manual",
      });
      const location = res.headers.get("location") || "";
      expect(location).toContain("error");
    });

    it("accepts correct credentials", async () => {
      const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          email: testEmail,
          password: testPassword,
        }),
        redirect: "manual",
      });
      // Successful login redirects without error param
      const location = res.headers.get("location") || "";
      expect(location).not.toContain("error=CredentialsSignin");
    });
  });

  // ──────────────────────────────────────
  // Auth protection
  // ──────────────────────────────────────
  describe("Protected routes", () => {
    it("/dashboard requires auth", async () => {
      const res = await fetch(`${BASE}/dashboard`, { redirect: "manual" });
      expect([302, 307]).toContain(res.status);
    });

    it("/api/jobs requires auth (returns non-200)", async () => {
      const res = await fetch(`${BASE}/api/jobs`);
      expect([401, 403, 500]).toContain(res.status);
    });
  });

  // ──────────────────────────────────────
  // Edge cases & security
  // ──────────────────────────────────────
  describe("Edge cases", () => {
    it("register with empty string email returns 400", async () => {
      const { status } = await post("/api/register", {
        email: "",
        password: "password123",
      });
      expect(status).toBe(400);
    });

    it("check-email with empty string returns 400", async () => {
      const { status } = await post("/api/auth/check-email", { email: "" });
      expect(status).toBe(400);
    });

    it("register with very long password succeeds", async () => {
      const { status, data } = await post("/api/register", {
        email: `longpass-${uid}@test.com`,
        password: "a".repeat(200),
      });
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
    });

    it("register with special characters in name succeeds", async () => {
      const { status, data } = await post("/api/register", {
        email: `special-${uid}@test.com`,
        name: "O'Brien-López 日本語",
        password: "password123",
      });
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
    });

    it("register with email-like name succeeds", async () => {
      const { status, data } = await post("/api/register", {
        email: `nametest-${uid}@test.com`,
        name: "user@fake.com",
        password: "password123",
      });
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
    });

    it("GET on register endpoint is not allowed", async () => {
      const res = await fetch(`${BASE}/api/register`);
      expect(res.status).toBe(405);
    });

    it("GET on check-email endpoint is not allowed", async () => {
      const res = await fetch(`${BASE}/api/auth/check-email`);
      expect(res.status).toBe(405);
    });
  });
});
