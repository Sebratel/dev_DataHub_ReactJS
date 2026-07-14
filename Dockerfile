# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────
# Stage 1 — build do front (apps/web, Vite/React)
# ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

# Variável de BUILD do Vite (embutida no bundle) — vem da stack do Portainer.
ARG VITE_GOOGLE_CLIENT_ID=""
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID

RUN npm run build --workspace apps/web

# ─────────────────────────────────────────────────────────────
# Stage 2 — serve estático com nginx (SPA) + proxy /api/
# ─────────────────────────────────────────────────────────────
FROM nginx:alpine AS serve

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
