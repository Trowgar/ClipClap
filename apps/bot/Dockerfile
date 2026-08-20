# --- Base ---
FROM node:20-alpine AS base
WORKDIR /app
# deno is yt-dlp's JavaScript runtime for YouTube (EJS). Without one, YouTube
# extraction is deprecated and already degraded - "some formats may be missing" -
# and a coming yt-dlp release makes it REQUIRED. Node cannot stand in: EJS wants
# Node >= 22 and this image is Node 20, so `--js-runtimes node` is a silent
# no-op here. That no-op once cost a whole session, because a test that "changed
# nothing" looked like proof the runtime was irrelevant.
RUN apk add --no-cache openssl python3 py3-pip deno
# PINNED, and the pin MUST match apps/worker/Dockerfile and apps/web/Dockerfile.
# Unpinned, each image got whatever pip's latest was on the day it was built:
# the bot sat on 2026.06.09 while worker-download ran 2026.07.04, so a link could
# pass the bot's probe and then fail the worker's download - a user-visible
# failure with no error to point at.
#
# `[default]` pulls in yt-dlp-ejs, the challenge-solver SCRIPTS. deno alone is
# not enough: without the scripts yt-dlp warns "[jsc] Remote components
# challenge solver script (deno) and NPM package (deno) were skipped", then
# "Signature solving failed" and "n challenge solving failed - Some formats may
# be missing". The alternative upstream offers is --remote-components
# ejs:github, which downloads the scripts AT RUN TIME; a local package is the
# right shape for a container that must not depend on a fetch mid-job.
#
# HONEST LIMIT: those warnings appear only when YouTube actually presents a
# challenge - intermittently, ~2 runs in 4 - and no format-count difference was
# measurable here (23 either way on the runs that were clean). This is installed
# because upstream requires it for YouTube, not because a regression was proven.
RUN pip3 install --break-system-packages "yt-dlp[default]==2026.8.19" \
    "bgutil-ytdlp-pot-provider==1.3.1"
# ^ the GVS PO-token plugin (spec 2026-08-19-youtube-flap-survival 2). Inert
# unless YTDLP_POT_PROVIDER_URL is set; pinned like yt-dlp itself so the three
# images cannot drift apart.

# --- Dependencies ---
FROM base AS deps
COPY package.json package-lock.json* ./
COPY apps/bot/package.json ./apps/bot/
COPY packages/shared/package.json ./packages/shared/
RUN npm install
COPY prisma/ ./prisma/
RUN npx prisma generate

# --- Development ---
FROM deps AS development
COPY . .
WORKDIR /app/apps/bot
CMD ["npx", "tsx", "watch", "src/index.ts"]

# --- Build ---
FROM deps AS build
COPY . .
RUN cd /app/packages/shared && npx tsc
WORKDIR /app/apps/bot
RUN npx tsc

# --- Production ---
FROM base AS production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/bot/package.json ./apps/bot/package.json
COPY --from=build /app/apps/bot/dist ./apps/bot/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/prisma ./prisma
RUN npx prisma generate
WORKDIR /app/apps/bot
CMD ["node", "dist/index.js"]
