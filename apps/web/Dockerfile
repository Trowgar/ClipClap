# --- Base ---
FROM node:20-alpine AS base
WORKDIR /app
# yt-dlp is needed on the SUBMIT path, not just in the worker: /api/jobs probes a
# pasted URL with `yt-dlp --simulate` to learn its real duration before a Job row
# exists. Without it the gate has nothing but the client's own claim, and a
# three-hour VOD is fully downloaded before anything refuses it.
#
# ffprobe is deliberately NOT here. An upload has already been PUT to R2 by the
# time this route runs, so measuring it would mean pulling the bytes back out of
# R2 into the web container to learn something the download stage - which has the
# file on disk and already has ffprobe - learns for free.
#
# Installed the same way the bot does it (pip, not apk) so both surfaces run the
# same yt-dlp and a site that breaks one breaks neither more nor less.
RUN apk add --no-cache openssl python3 py3-pip
RUN pip3 install --break-system-packages yt-dlp

# --- Dependencies ---
FROM base AS deps
COPY package.json package-lock.json* ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN npm install

# GeoLite2-Country for visitor countries. Optional by design: without a licence
# key the build still succeeds and country lookups return null at runtime.
ARG MAXMIND_LICENSE_KEY=""
RUN mkdir -p /app/geoip && \
    if [ -n "$MAXMIND_LICENSE_KEY" ]; then \
      apk add --no-cache curl tar && \
      curl -fsSL "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-Country&license_key=${MAXMIND_LICENSE_KEY}&suffix=tar.gz" \
        -o /tmp/geo.tgz && \
      tar -xzf /tmp/geo.tgz -C /tmp && \
      find /tmp -name 'GeoLite2-Country.mmdb' -exec cp {} /app/geoip/ \; && \
      rm -rf /tmp/geo.tgz; \
    else \
      echo "MAXMIND_LICENSE_KEY not set - country lookups will return null"; \
    fi

# Copy prisma AFTER npm install to avoid cache issues
COPY prisma/ ./prisma/
RUN npx prisma generate

# --- Development ---
FROM deps AS development
COPY . .
WORKDIR /app/apps/web
CMD ["npx", "next", "dev", "--turbo", "--hostname", "0.0.0.0"]

# --- Build ---
FROM deps AS build
COPY . .
WORKDIR /app/apps/web
RUN npx next build

# --- Production ---
FROM base AS production
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
CMD ["node", "apps/web/server.js"]
