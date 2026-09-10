#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
http_config="$repo_root/ops/nginx/clipclap-security-http.conf"
server_config="$repo_root/ops/nginx/clipclap-security-server.conf"
site_config="$repo_root/ops/nginx/clipclap-site.conf"
filter_config="$repo_root/ops/fail2ban/filter.d/clipclap-scanner.conf"
jail_config="$repo_root/ops/fail2ban/jail.d/clipclap-scanner.local"
fixture="$repo_root/ops/tests/fixtures/clipclap-access.log"

for required in "$http_config" "$server_config" "$site_config" "$filter_config" "$jail_config"; do
  test -f "$required" || {
    echo "missing required config: $required" >&2
    exit 1
  }
done

grep -Fq 'zone=clipclap_dynamic:10m rate=10r/s' "$http_config"
grep -Fq 'zone=clipclap_auth:10m rate=5r/m' "$http_config"
grep -Fq 'zone=clipclap_action:10m rate=10r/m' "$http_config"
grep -Fq 'zone=clipclap_conn:10m' "$http_config"
grep -Fq '~*^/api/auth/check-email(?:/|$) 1;' "$http_config"
grep -Fq 'client_max_body_size 1m;' "$server_config"
grep -Fq 'limit_conn clipclap_conn 30;' "$server_config"
grep -Fq 'access_log /var/log/nginx/clipclap.access.log combined;' "$server_config"
grep -Fq 'include /etc/nginx/snippets/clipclap-security-server.conf;' "$site_config"
grep -Fq 'maxretry = 3' "$jail_config"
grep -Fq 'bantime = 24h' "$jail_config"
grep -Fq 'bantime.maxtime = 30d' "$jail_config"

docker run --rm \
  -v "$repo_root/ops/nginx:/config:ro" \
  -v "$repo_root/ops/tests/nginx.conf:/etc/nginx/nginx.conf:ro" \
  nginx:1.28-alpine nginx -t

fail2ban-regex "$fixture" "$filter_config" --print-all-matched | grep -Fq '3 matched'

echo "web abuse protection config checks passed"
