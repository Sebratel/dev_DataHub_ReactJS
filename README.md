# Data Hub Sebratel

Centralizador de dados (lakehouse com conectores) + catálogo amigável + dashboards + IA.
Arquitetura completa em [docs/01-ARQUITETURA-MVP.md](docs/01-ARQUITETURA-MVP.md).

**Conjuntos derivados** (Sprint 7): editores escrevem SQL (DuckDB, somente
SELECT) juntando/tratando conjuntos já ingeridos — referenciados pelo slug ou
pelo apelido com underscore. O resultado é materializado como Parquet no lake
(logo após a janela diária e sob demanda) e vira um conjunto normal: explorável,
com métricas, dashboards e visível para a IA. Zero carga nas fontes.

## Estrutura

```
apps/web        Frontend React + Vite + Tailwind (mesmos padrões do churn_mvp)
apps/api        Backend Node + TypeScript (Express modular)
packages/shared Tipos compartilhados (QueryDef, DatasetMeta, ChartSpec)
docs/           Documentação de arquitetura
```

## Rodando em desenvolvimento

1. Copie `.env.example` para `.env` e preencha (as credenciais das fontes são as
   mesmas do churn_mvp).
2. Suba o banco de metadados: `docker compose up -d datahub-db`
3. Instale e rode:

```bash
npm install
npm run dev:api   # API em http://localhost:8790
npm run dev:web   # Web em http://localhost:5174 (proxy /api → 8790)
```

As migrations do banco `datahub` rodam automaticamente no boot da API.

## Deploy em produção (Portainer)

Mesmo fluxo do churn_mvp — stack por repositório:

1. Publique este repositório no GitHub (`Sebratel/...`, privado).
2. No Portainer: **Stacks → Add stack → Repository**, apontando para o repositório
   e branch `main` (compose file: `docker-compose.yml`).
3. Preencha as **Environment variables** da stack (não vão para o git):
   - `VITE_GOOGLE_CLIENT_ID`, `ALLOWED_DOMAIN`, `ADMIN_EMAILS`
   - `DATAHUB_DB_PASSWORD` (obrigatória — senha do banco de metadados)
   - Credenciais das fontes: `DB_ELLEVEN_*`, `DB_RADIUS_*`, `DB_MARIA_*`, `DB_AUTOISP_*`
   - Lake: `BUCKET_GCP_NAME`, `PATH_CREDENTIALS`
   - IA (chat com tools): `ANTHROPIC_API_KEY` (sem ela o resto funciona normal;
     opcionais `AI_PROVIDER`, `AI_MODEL`)
   - Opcional: `WEB_PORT` (padrão 8082), `ETL_HOUR` (padrão 3)
4. Deploy. A stack sobe `datahub-db` → `api` (migrations automáticas) → `web` (nginx).
5. No Google Cloud Console, adicione a URL pública do web em
   *Authorized JavaScript origins* do client OAuth.

Redeploys puxam o branch e rebuildam as imagens (`pull_policy: build`). O volume
`datahub-db-data` preserva o catálogo entre redeploys.

## Segurança

- Fontes de dados são acessadas **somente para leitura** (guard + usuário read-only).
- Ingestão apenas em janela de madrugada, incremental e em lotes — consultas de
  usuários batem no lake, nunca nos bancos de produção.
- Credenciais só existem no `.env` (nunca no banco nem no git).
- **Alterar como uma FONTE atualiza** (modo, chaves incrementais, identidade da
  linha, cadência e agendamento) é do **admin master** — a lista está em
  `MASTER_ADMIN_EMAILS` no ambiente do servidor, não no banco, porque o papel
  `admin` é concedido pela própria tela de acessos e qualquer admin poderia se
  promover. Conjuntos **calculados** seguem com admin/editor: rodam sobre o
  lake e não tocam fonte. Disparar e cancelar uma carga continuam com admin —
  são operação, não mudança de regra.
