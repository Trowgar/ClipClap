# --- Base ---
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl

# --- Dependencies ---
FROM base AS deps
COPY package.json package-lock.json* ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN npm install
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
