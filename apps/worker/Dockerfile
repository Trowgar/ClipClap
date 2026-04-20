# --- Base ---
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache ffmpeg python3 py3-pip openssl
RUN pip3 install --break-system-packages yt-dlp

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
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/prisma ./prisma
RUN npx prisma generate
WORKDIR /app/apps/worker
CMD ["node", "dist/index.js"]
