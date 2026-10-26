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

# Firebase Authentication: o UNICO login do Data Hub (o Google Identity Services
# saiu no SEG-07). Variaveis de BUILD do Vite, embutidas no bundle, vindas da
# stack do Portainer. Aqui ficam com padrao vazio para o CI conseguir montar a
# imagem; quem exige o valor e o docker-compose.yml, que recusa o deploy sem
# elas. Nao sao segredo: valores de projeto Firebase sao publicos por design.
ARG VITE_FIREBASE_API_KEY=""
ARG VITE_FIREBASE_AUTH_DOMAIN=""
ARG VITE_FIREBASE_PROJECT_ID=""
ARG VITE_FIREBASE_APP_ID=""
ARG VITE_ALLOWED_DOMAIN=""
ENV VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY
ENV VITE_FIREBASE_AUTH_DOMAIN=$VITE_FIREBASE_AUTH_DOMAIN
ENV VITE_FIREBASE_PROJECT_ID=$VITE_FIREBASE_PROJECT_ID
ENV VITE_FIREBASE_APP_ID=$VITE_FIREBASE_APP_ID
ENV VITE_ALLOWED_DOMAIN=$VITE_ALLOWED_DOMAIN

RUN npm run build --workspace apps/web

# ─────────────────────────────────────────────────────────────
# Stage 2 — serve estático com nginx (SPA) + proxy /api/
# ─────────────────────────────────────────────────────────────
FROM nginx:alpine AS serve

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

# 127.0.0.1 e nao localhost, de proposito.
#
# No Alpine (musl), `localhost` resolve ::1 ANTES de 127.0.0.1, e o wget do
# busybox tenta so o primeiro endereco. O nginx aqui escuta `listen 80`, que e
# IPv4 apenas -- entao a checagem batia em ::1, levava recusa de conexao e o
# container ficava unhealthy enquanto servia tudo normalmente pela porta
# publicada. Foram 32 checagens seguidas falhando antes de alguem reparar.
#
# A API nao tem esse problema com a MESMA linha de healthcheck porque o Node
# abre o socket em :: (dual-stack) por padrao. A diferenca esta no servidor,
# nao no wget.
#
# Fixar o IPv4 resolve sem mexer no que o nginx aceita de fora.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
