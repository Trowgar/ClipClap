# --- Base ---
FROM node:20-alpine AS base
WORKDIR /app
# deno: yt-dlp's JavaScript runtime for YouTube (EJS). See apps/bot/Dockerfile
# for why Node cannot stand in for it on this image.
RUN apk add --no-cache ffmpeg python3 py3-pip openssl fontconfig py3-opencv py3-numpy deno
# PINNED, and the pin MUST match apps/bot/Dockerfile and apps/web/Dockerfile -
# the bot probes a link with one version and this image downloads it with
# another, so a drift means a link that passes the gate and then fails the job.
# `[default]` pulls in yt-dlp-ejs, the challenge-solver scripts deno runs. See
# apps/bot/Dockerfile for the full reasoning and its measured limits.
RUN pip3 install --break-system-packages "yt-dlp[default]==2026.7.4"

# --- Dependencies ---
FROM base AS deps
COPY package.json package-lock.json* ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/shared/package.json ./packages/shared/
RUN npm install
COPY prisma/ ./prisma/
RUN npx prisma generate

# --- Development ---
FROM deps AS development
COPY . .
WORKDIR /app/apps/worker
CMD ["npx", "tsx", "watch", "src/index.ts"]

# --- Build ---
FROM deps AS build
COPY . .
RUN cd /app/packages/shared && npx tsc
WORKDIR /app/apps/worker
RUN npx tsc

# --- Production ---
FROM base AS production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/assets ./apps/worker/assets
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/prisma ./prisma
RUN npx prisma generate
WORKDIR /app/apps/worker
CMD ["node", "dist/index.js"]
