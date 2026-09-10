# Web abuse protection

ClipClap rejects impossible scanner paths in Nginx, rate-limits expensive unauthenticated traffic, and lets Fail2ban temporarily block repeat offenders through UFW. The repository copies are canonical:

- `ops/nginx/clipclap-security-http.conf` → `/etc/nginx/conf.d/clipclap-security-http.conf`
- `ops/nginx/clipclap-security-server.conf` → `/etc/nginx/snippets/clipclap-security-server.conf`
- `ops/nginx/clipclap-site.conf` → `/etc/nginx/sites-available/clipclap`
- `ops/fail2ban/filter.d/clipclap-scanner.conf` → `/etc/fail2ban/filter.d/clipclap-scanner.conf`
- `ops/fail2ban/jail.d/clipclap-scanner.local` → `/etc/fail2ban/jail.d/clipclap-scanner.local`

## Active policy

- The retired `/api/auth/check-email` oracle and known CMS, secret-file, VCS, PHP/backdoor, and WordPress REST probes: Nginx `444` before proxying.
- General dynamic traffic: 10 requests/second, burst 30.
- Registration, password recovery/reset, and credential callback POSTs: 5 requests/minute, burst 5.
- Requests carrying `Next-Action`: 10 requests/minute, burst 10.
- Concurrent connections: 30 per source address.
- Proxy and Next Server Action bodies: 1 MB.
- Three `444`/`429` responses in 10 minutes: 24-hour web-only UFW ban; repeat bans double up to 30 days.
- `/_next/static/` and `/_next/image` do not consume the general request budget. OAuth provider callbacks do not consume the strict credential budget.

The explicit UFW deny for `195.178.110.105` is permanent and separate from Fail2ban.

## Inspect

```bash
sudo nginx -t
sudo fail2ban-client -t
sudo fail2ban-client status clipclap-scanner
sudo ufw status numbered
sudo tail -f /var/log/nginx/clipclap.access.log
sudo journalctl -u fail2ban --since today
```

Inspect one address without changing state:

```bash
sudo grep -F '203.0.113.10' /var/log/nginx/clipclap.access.log
sudo fail2ban-client get clipclap-scanner banip --with-time
```

## Test repository config

```bash
bash ops/tests/web-abuse-protection.sh
```

The test validates Nginx syntax in the pinned container and checks the Fail2ban filter against malicious and legitimate fixtures.

## Reload after a policy change

Copy repository configs to their paths above, then validate both candidates before changing either running service:

```bash
sudo nginx -t
sudo fail2ban-client -t
sudo systemctl reload nginx
sudo fail2ban-client reload
sudo fail2ban-client status clipclap-scanner
```

## Unban a false positive

```bash
sudo fail2ban-client set clipclap-scanner unbanip 203.0.113.10
```

Do not delete UFW rules by an assumed number; rule numbers move. First run `sudo ufw status numbered`, verify the exact address/comment, then delete the resolved rule.

## Rollback

The initial deployment backup is `/var/backups/clipclap-security/20260910T165348Z/clipclap.site.conf`. To roll back the edge policy while retaining the permanent malicious-IP deny:

```bash
sudo install -m 0644 /var/backups/clipclap-security/20260910T165348Z/clipclap.site.conf /etc/nginx/sites-available/clipclap
sudo rm /etc/nginx/conf.d/clipclap-security-http.conf
sudo rm /etc/nginx/snippets/clipclap-security-server.conf
sudo rm /etc/fail2ban/jail.d/clipclap-scanner.local
sudo nginx -t
sudo fail2ban-client -t
sudo systemctl reload nginx
sudo fail2ban-client reload
```

The rollback commands are intentionally manual because they remove active controls; verify the paths and backup before running them.

## Known follow-ups

Password reset does not currently invalidate already-issued JWT sessions, and the job-event SSE route can log a double-close error on disconnect. They are separate lifecycle fixes and were not required to contain this scanner incident.
