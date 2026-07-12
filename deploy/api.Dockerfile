# syntax=docker/dockerfile:1.7
# Multi-stage build для NestJS API.
# Контекст билда — корень монорепо.

# L11 (supply chain): base-образ запинен по digest, а не по плавающему тегу
# 20-alpine — воспроизводимость билда и защита от подмены тега. Бампить digest
# осознанно (renovate/dependabot или вручную):
#   docker buildx imagetools inspect node:20-alpine --format '{{.Manifest.Digest}}'
ARG NODE_VERSION=20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

FROM node:${NODE_VERSION} AS builder
RUN apk add --no-cache libc6-compat openssl
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /workspace

# 1. Метаданные пакетов для слоя зависимостей
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/

# 2. Полная установка (dev+prod) — нужна для билда
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# 3. Исходники и билд
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY apps/api ./apps/api

RUN pnpm --filter @construct/shared build \
 && pnpm --filter @construct/db build \
 && pnpm --filter @construct/api build

# 4. `pnpm deploy` собирает изолированный production-набор для api
RUN pnpm --filter @construct/api --prod deploy /deploy

# 5. Регенерация prisma client внутри /deploy (CLI уже там как зависимость пакета)
RUN cd /deploy/node_modules/@construct/db && npx prisma generate

FROM node:${NODE_VERSION} AS runner
RUN apk add --no-cache libc6-compat openssl tini
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

# Непривилегированный пользователь (Фаза 1 п.8). Образ node уже содержит
# юзера `node` (uid 1000); файлы /deploy сразу под ним.
COPY --from=builder --chown=node:node /deploy ./
# UPLOAD_DIR=/app/data/uploads — создаём под node, чтобы СВЕЖИЙ volume
# унаследовал node-владение при первом монтировании. ⚠️ Существующий volume
# на VPS уже root-owned: после деплоя разово
# `docker compose -f deploy/docker-compose.prod.yml exec -u 0 api chown -R node:node /app/data`.
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data
USER node

EXPOSE 4000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
