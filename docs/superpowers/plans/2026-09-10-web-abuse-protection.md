# Web Abuse Protection Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Stop automated endpoint scans before they reach Next.js, remove the public account-enumeration oracle, and automatically ban repeat scanners without disrupting normal OAuth and application traffic.

**Architecture:** Nginx is the first enforcement layer: it drops known scan paths, caps per-IP concurrency, and applies separate request budgets to general dynamic requests, credential endpoints, and Next Server Actions. Fail2ban consumes a dedicated ClipClap access log and escalates repeated Nginx rejections into firewall bans. The application removes the email lookup endpoint, changes login to an explicit sign-in/register flow, limits Server Action bodies, and upgrades patched framework/auth releases.

**Tech Stack:** Nginx, Fail2ban/UFW, Next.js 15, Auth.js 5 beta, React, Vitest, Bash, Docker Compose.

---

### Task 1: Establish focused regression tests

**Files:**
- Create: `apps/web/src/__tests__/login-account-oracle.test.ts`
- Create: `ops/tests/web-abuse-protection.sh`
- Create: `ops/tests/fixtures/clipclap-access.log`

**Step 1: Write the failing application test**

Add a source-level Vitest regression that reads `app/(auth)/login/login-form.tsx`, asserts it does not call `/api/auth/check-email`, asserts it offers an explicit registration transition, asserts the enumeration route no longer exists, and asserts `next.config.ts` uses a `1mb` Server Action limit.

**Step 2: Run the application test and verify it fails**

Run `npx vitest run apps/web/src/__tests__/login-account-oracle.test.ts` under Node 20. Expected: failure because the lookup route and `5gb` limit still exist.

**Step 3: Write the failing infrastructure test**

Add a shell test that requires the Nginx HTTP/server snippets and Fail2ban filter/jail, checks the agreed rate/concurrency/body limits, and runs `fail2ban-regex` against a fixture containing 444/429 rejections.

**Step 4: Run the infrastructure test and verify it fails**

Run `bash ops/tests/web-abuse-protection.sh`. Expected: failure because the production config files do not exist yet.

### Task 2: Remove account enumeration and constrain Server Actions

**Files:**
- Modify: `apps/web/app/(auth)/login/login-form.tsx`
- Delete: `apps/web/app/api/auth/check-email/route.ts`
- Modify: `apps/web/next.config.ts`

**Step 1: Replace lookup-driven routing**

Make email submission enter the password sign-in step locally. Add an explicit “Create account” action from that step which enters registration; keep back navigation and provider sign-in available.

**Step 2: Remove the public oracle**

Delete `apps/web/app/api/auth/check-email/route.ts` so unauthenticated callers cannot learn whether an email exists or has a password.

**Step 3: Lower the action payload ceiling**

Change `experimental.serverActions.bodySizeLimit` from `5gb` to `1mb`.

**Step 4: Run focused tests**

Run the new test and the complete `apps/web` Vitest set under Node 20. Expected: all pass.

### Task 3: Add reproducible edge and ban policy

**Files:**
- Create: `ops/nginx/clipclap-security-http.conf`
- Create: `ops/nginx/clipclap-security-server.conf`
- Create: `ops/fail2ban/filter.d/clipclap-scanner.conf`
- Create: `ops/fail2ban/jail.d/clipclap-scanner.local`
- Modify: `ops/tests/web-abuse-protection.sh`

**Step 1: Define shared Nginx zones and scan classification**

Define IP-keyed zones for 10 requests/second dynamic traffic, 5 requests/minute unauthenticated credential traffic, 10 requests/minute Next Actions, and 30 concurrent connections. Map common CMS, secret-file, source-control, traversal, and executable-extension scan paths to an immediate 444 response.

**Step 2: Define server-level enforcement**

Use a dedicated `/var/log/nginx/clipclap.access.log`, set `client_max_body_size 2m`, apply connection/general request limits, apply strict credential/Server Action budgets without limiting OAuth callback GETs, and exclude immutable Next assets from the general budget.

**Step 3: Define Fail2ban escalation**

Match only ClipClap access-log 444/429 responses. Ban after 3 hits in 10 minutes for 24 hours, enable incremental repeat bans, and cap them at 30 days using the UFW action.

**Step 4: Prove config behavior**

Run the shell regression, `nginx -t` in an isolated test configuration, and `fail2ban-regex` against the fixture. Expected: syntax valid and malicious lines matched without matching the normal 200 line.

### Task 4: Upgrade vulnerable framework/auth dependencies

**Files:**
- Modify: `apps/web/package.json`
- Modify: `package-lock.json`

**Step 1: Update within compatible release lines**

Upgrade Next.js from `15.5.14` to patched `15.5.18` and Auth.js from beta 30 to beta 32 (including the compatible Prisma adapter lockfile resolution). Do not run a broad major-version audit fix.

**Step 2: Verify dependency resolution and build**

Run `npm ls next next-auth @auth/core @auth/prisma-adapter`, focused web tests, lint/type checks available to the web package, and a production Next build under Node 20.

### Task 5: Install and exercise host protections

**Files:**
- Modify: `/etc/nginx/conf.d/clipclap-security-http.conf`
- Modify: `/etc/nginx/snippets/clipclap-security-server.conf`
- Modify: `/etc/nginx/sites-available/clipclap`
- Modify: `/etc/fail2ban/filter.d/clipclap-scanner.conf`
- Modify: `/etc/fail2ban/jail.d/clipclap-scanner.local`

**Step 1: Back up and install exact repository configs**

Create timestamped backups of the active Nginx site and any replaced security files. Install the tested snippets and add one idempotent include to the ClipClap server block.

**Step 2: Validate before reload**

Run `sudo nginx -t` and `sudo fail2ban-client -t`. Do not reload either service unless both validators pass.

**Step 3: Reload and test externally**

Reload Nginx and Fail2ban. Verify a normal page and OAuth callback are not blocked, scan paths return a dropped/444 connection, oversized requests return 413, bursts reach 429, and the custom jail is active. Confirm `195.178.110.105` remains blocked by UFW.

### Task 6: Document, merge, and deploy

**Files:**
- Create: `docs/runbooks/web-abuse-protection.md`

**Step 1: Document operations**

Record limits, log locations, inspection/unban commands, config validation, rollback, and known exclusions.

**Step 2: Run final verification**

Run focused tests, production build, dependency tree/audit, Nginx/Fail2ban validators, live HTTP checks, and inspect service/container health. Record any unrelated baseline failures separately.

**Step 3: Integrate into main**

Commit coherent changes on `fix/web-abuse-protection`, update the clean `main` worktree with a non-destructive merge, rerun the final smoke checks at the merge commit, and push `main` to origin.

**Step 4: Deploy the main commit**

Build the production web image and `.next` artifact with the host’s existing Compose override workflow, recreate only the web service, then verify the deployed revision, health endpoint, normal login page, scan rejection, logs, and Fail2ban status.
