# Web Abuse Protection Design

**Date:** 2026-09-10

## Goal

Stop commodity web scanners before they reach Next.js, bound abusive request rates, remove the public account-enumeration oracle, and patch the framework versions implicated by the incident without breaking OAuth, Telegram login, uploads, or authenticated job processing.

## Incident baseline

The triggering client, `195.178.110.105`, sent 712 requests between 10:59:19 and 11:00:52 UTC. Its WordPress, Auth.js, and fake Server Action probes produced no users, jobs, withdrawals, or other product-side effects. UFW now has a persistent top-priority deny rule for this address.

The scan nevertheless reached Next.js and produced hundreds of framework errors and at least 565 analytics pageviews because the client impersonated Chrome. The current host Nginx configuration has no request limiting, shares its default access log with unrelated virtual hosts, permits 100 MB request bodies on every ClipClap route, and forwards all paths to the application.

## Scope

This change includes:

- repository-managed Nginx and Fail2ban configuration, installed on the current host;
- deterministic blocking of paths that cannot be valid ClipClap traffic;
- rate limits for dynamic traffic, authentication endpoints, and Server Actions;
- a ClipClap-specific access log so automatic bans cannot be triggered by the host's WordPress virtual host;
- removal of `/api/auth/check-email` and a login flow that no longer discloses account existence;
- a lower Server Action body limit;
- supported security updates for Next.js and Auth.js;
- tests and live verification of the controls.

This change does not include JWT invalidation after password reset or the existing SSE disconnect bug. Both are real, but they have independent state/lifecycle designs and are not necessary to contain this incident.

## Layer 1: deterministic Nginx rejection

Nginx will return status `444` before proxying paths that have no valid meaning in ClipClap:

- dot-secret and source-control probes such as `/.env`, nested `/.env`, and `/.git`;
- WordPress endpoints such as `/wp-json`, `/wp-admin`, `/wp-login.php`, and `/xmlrpc.php`;
- PHP scripts and phpMyAdmin/Adminer probes;
- common shell/backdoor filenames.

The rule must not block `/admin`, because ClipClap has a legitimate Telegram-gated admin page. Matching is based on the normalized URI, not only the query string, and includes the WordPress `rest_route` query form seen in the incident.

ClipClap receives its own access log at `/var/log/nginx/clipclap.access.log`. This is a safety boundary: Fail2ban must never interpret legitimate WordPress traffic to another site on the same host as an attack on ClipClap.

## Layer 2: bounded request rates and bodies

Nginx uses native shared-memory rate zones keyed by the real remote address:

- dynamic/page traffic: 10 requests/second with a burst of 30;
- sensitive unauthenticated auth traffic: 5 requests/minute with a burst of 5;
- requests carrying a `Next-Action` header: 10 requests/minute with a burst of 10;
- concurrent connections: 30 per address.

Rate-limited requests return `429`. Static Next.js assets and image responses are not charged to the dynamic zone. OAuth provider/callback GETs are not charged to the strict auth zone. The strict zone covers credential callbacks, registration, password reset requests/redemption, and the legacy account-check route while it is being removed.

The public proxy body limit becomes 1 MB. Web video bytes already upload directly to presigned object-storage URLs, so the application proxy does not need the current 100 MB allowance. Next.js Server Actions receive the same 1 MB ceiling instead of 5 GB.

## Layer 3: automatic bans

Fail2ban watches only `/var/log/nginx/clipclap.access.log`. A custom filter counts Nginx `444` scanner rejections and `429` rate-limit responses. Three matches from one address within ten minutes cause a 24-hour UFW ban on web access.

Fail2ban's incremental ban feature lengthens repeat bans, capped at 30 days. The current malicious IP remains permanently denied by the explicit UFW rule; it does not depend on the temporary jail.

The filter is tested against both the incident's malicious request samples and ordinary ClipClap/OAuth requests. Legitimate examples must produce zero matches.

## Layer 4: remove account enumeration

`POST /api/auth/check-email` is deleted. The login form stops asking the server whether an address exists.

After an email is entered, the browser shows the credential sign-in form and an explicit “Create account” action. A user with a Google- or Telegram-only account can still choose the existing provider buttons. Registration remains responsible for safely reporting a duplicate at the actual create boundary; removing every possible registration oracle would require a different account-creation protocol and is outside this containment change.

This removes the cheap bulk-enumeration endpoint while preserving all supported login and signup paths.

## Layer 5: dependency patching

Update within the existing major versions:

- Next.js to at least `15.5.18`;
- NextAuth to at least `5.0.0-beta.32`;
- the Prisma Auth adapter and transitive Auth core to versions containing the corresponding fixes.

The lockfile is updated explicitly. No broad `npm audit fix --force` is used. Remaining advisories are reviewed for reachability, and the production build plus existing tests must pass before deployment.

## Failure handling and rollback

Every host configuration change is syntax-tested before reload. Nginx is reloaded, not restarted, so a bad candidate configuration never replaces the running one. Fail2ban configuration is validated before its jail is enabled.

The repository stores the canonical host configuration and an installation runbook. Rollback consists of restoring the previous ClipClap site file, removing the ClipClap Fail2ban jail, validating, and reloading the two services. The permanent UFW deny for `195.178.110.105` is intentionally retained.

## Verification

Verification covers:

- unit/component tests proving the login form makes no account-check request;
- absence of the account-check route from the built application;
- red/green tests for scanner-path classification or config fixtures;
- `nginx -t` and `fail2ban-regex` against malicious and legitimate samples;
- live requests showing scanner paths receive `444`, excess safe test traffic receives `429`, and normal landing/login/OAuth endpoints still respond;
- full workspace tests and a production Next.js build;
- a final database check confirming verification traffic created no user, job, usage, payment, or withdrawal records.

