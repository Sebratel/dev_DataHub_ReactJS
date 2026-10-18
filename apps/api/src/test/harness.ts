// ─────────────────────────────────────────────────────────────────────────
// Harness dos testes de integração — a API REAL, rota por rota, contra um
// banco de teste. É a base dos testes do plano do comitê (DATAHUB v0.1, §10):
// cada arquivo *.test.ts cobre um bloco (T-FUN, T-SEG…) e cada teste leva o ID
// do documento no nome, para o resultado voltar direto para a planilha.
//
// O que é real e o que é simulado:
//   • REAL: Express com todas as rotas (createApp), Postgres com todas as
//     migrations, DuckDB com a trava do motor, Parquet no disco, o caminho de
//     verificação do ID token do Firebase (assinatura RS256, emissor, público).
//   • SIMULADO: só o Google. Os tokens são assinados por uma chave gerada aqui,
//     injetada como se fosse a do Google (__setCertsForTest). Nenhuma chamada
//     de rede sai — nem para o Google, nem para provedor de IA.
//
// SEGURANÇA DO PRÓPRIO TESTE: o harness APAGA e recria o banco que usa. Por
// isso o nome é fixo (datahub_test), o host tem de ser local, e tudo é
// definido ANTES de qualquer import da API — o dotenv não sobrescreve variável
// já definida, então o .env real nunca decide para onde o teste escreve.
// ─────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process'
import { createSign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// Um banco por PROCESSO: o `node --test` roda os arquivos em paralelo, e cada
// um recria o seu do zero. O prefixo fixo é o que a guarda abaixo confere.
export const TEST_DB = `datahub_test_${process.pid}`
export const PROJECT = 'datahub-test-project'
export const DOMAIN = 'sebratel.com.br'

// Contas fixas, uma por perfil do documento (§3.5 e §10.1).
export const USERS = {
  master: `teste.master@${DOMAIN}`,
  admin: `teste.admin@${DOMAIN}`, // admin SEM master
  editor: `teste.editor@${DOMAIN}`,
  editor2: `teste.editor2@${DOMAIN}`,
  viewer: `teste.viewer@${DOMAIN}`,
  viewer2: `teste.viewer2@${DOMAIN}`,
  externo: 'alguem@gmail.com',
} as const
export type Who = keyof typeof USERS

const work = mkdtempSync(join(tmpdir(), 'datahub-it-'))
const lakeRoot = join(work, 'lake')
mkdirSync(lakeRoot, { recursive: true })

// ── Ambiente: ANTES de importar qualquer módulo da API ──────────────────────
const host = process.env.DATAHUB_TEST_DB_HOST || 'localhost'
if (!/^(localhost|127\.0\.0\.1|::1|postgres|datahub-db)$/.test(host)) {
  throw new Error(
    `DATAHUB_TEST_DB_HOST="${host}" não é local. O harness apaga e recria o banco ${TEST_DB}; ` +
    'ele só roda contra um Postgres de desenvolvimento ou de CI.',
  )
}
const TEST_ENV: Record<string, string> = {
  DATAHUB_DB_HOST: host,
  DATAHUB_DB_PORT: process.env.DATAHUB_TEST_DB_PORT || process.env.DATAHUB_DB_PORT || '5433',
  DATAHUB_DB_DATABASE: TEST_DB,
  FIREBASE_PROJECT_ID: PROJECT,
  ALLOWED_DOMAIN: DOMAIN,
  ADMIN_EMAILS: `${USERS.master},${USERS.admin}`,
  MASTER_ADMIN_EMAILS: USERS.master,
  CONNECTIONS_SECRET: 'segredo-so-de-teste-nao-usar-em-producao',
  LAKE_ROOT: lakeRoot,
  SYNC_STAGING_DIR: join(lakeRoot, '.staging'),
  // Nada de rede nem de trabalho de fundo.
  ANTHROPIC_API_KEY: '',
  EMBEDDINGS_ENABLED: 'false',
  DATABRICKS_SYNC_ENABLED: 'false',
  BUCKET_GCP_NAME: '',
  PATH_CREDENTIALS: '',
}
Object.assign(process.env, TEST_ENV)
if (process.env.DATAHUB_TEST_DB_USER) process.env.DATAHUB_DB_USER = process.env.DATAHUB_TEST_DB_USER
if (process.env.DATAHUB_TEST_DB_PASSWORD) process.env.DATAHUB_DB_PASSWORD = process.env.DATAHUB_TEST_DB_PASSWORD

// O .env da raiz é o de DESENVOLVIMENTO e traz credenciais reais: as fontes
// (DB_ELLEVEN_*, DB_RADIUS_*, DB_MARIA_*, DB_AUTOISP_* — bancos de produção),
// Databricks, IA. Na primeira versão deste harness, o GET /connections do
// T-SEG-13 abriu conexão com as fontes de verdade (as conexões "nativas" vêm
// dessas variáveis e a listagem as testa). Então: TODA variável do .env vira
// vazia aqui, menos o acesso ao Postgres local de teste. Vazia — e não
// ausente — porque o dotenv não sobrescreve chave já definida. Por lista do
// que fica, não do que sai: uma variável nova no .env já nasce fora do teste.
const MANTEM = new Set(['DATAHUB_DB_USER', 'DATAHUB_DB_PASSWORD'])
try {
  const envFile = readFileSync(new URL('../../../../.env', import.meta.url), 'utf8')
  for (const [, k] of envFile.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) {
    if (!MANTEM.has(k) && !(k in TEST_ENV)) process.env[k] = ''
  }
} catch { /* sem .env (CI): nada a neutralizar */ }

// Daqui para baixo, imports dinâmicos: só agora a configuração é lida.
const { config } = await import('../core/config.js')
const pg = (await import('pg')).default

// Recria o banco de teste do zero — cada execução parte do mesmo estado.
{
  const admin = new pg.Client({ ...config.datahubDb, database: 'postgres' })
  await admin.connect()
  await admin.query(`drop database if exists ${TEST_DB} with (force)`)
  await admin.query(`create database ${TEST_DB}`)
  await admin.end()
}

const { db, runMigrations, isDbAvailable } = await import('../db/pool.js')
await runMigrations(1, 0)
if (!isDbAvailable()) throw new Error('Migrations falharam no banco de teste (veja o log acima).')

export { db }
export const { duckQuery } = await import('../modules/query/duck.js')
const { __setCertsForTest } = await import('../modules/auth/firebaseToken.js')
const { reloadMasterAdmins } = await import('../modules/auth/masterAdmins.js')
const { reloadUpstreams } = await import('../modules/gateway/upstreams.js')
const { createApp } = await import('../app.js')
const { closeAllPools } = await import('../connectors/pools.js')
await reloadMasterAdmins()
await reloadUpstreams()

// ── Identidade: um "Google" de mentira, com a verificação de verdade ───────
const certDir = join(work, 'cert')
mkdirSync(certDir)
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', join(certDir, 'k.pem'), '-out', join(certDir, 'c.pem'), '-days', '1', '-subj', '/CN=teste'],
{ stdio: 'ignore' })
const keyPem = readFileSync(join(certDir, 'k.pem'), 'utf8')
__setCertsForTest({ 'kid-teste': readFileSync(join(certDir, 'c.pem'), 'utf8') })

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
export function idToken(email: string, over: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: email,
    iat: now - 10, exp: now + 3600, email, email_verified: true, name: email.split('@')[0],
    ...over,
  }
  const data = `${b64({ alg: 'RS256', kid: 'kid-teste', typ: 'JWT' })}.${b64(payload)}`
  return `${data}.${createSign('RSA-SHA256').update(data).sign(keyPem).toString('base64url')}`
}

// ── Servidor ───────────────────────────────────────────────────────────────
const server: Server = await new Promise((resolve) => {
  const s = createApp().listen(0, () => resolve(s))
})
export const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

export interface Res<T = any> { status: number; body: T; headers: Headers }

async function call<T>(method: string, path: string, opts: { token?: string; apiToken?: string; body?: unknown } = {}): Promise<Res<T>> {
  const headers: Record<string, string> = {}
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  if (opts.apiToken) headers['X-Api-Token'] = opts.apiToken
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  const r = await fetch(baseUrl + path, {
    method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await r.text()
  let body: unknown = text
  try { body = JSON.parse(text) } catch { /* CSV, texto */ }
  return { status: r.status, body: body as T, headers: r.headers }
}

/** Cliente HTTP autenticado como um dos perfis de teste. */
export function as(who: Who) {
  const token = idToken(USERS[who])
  return {
    email: USERS[who],
    token,
    get: <T = any>(p: string) => call<T>('GET', p, { token }),
    post: <T = any>(p: string, body?: unknown) => call<T>('POST', p, { token, body: body ?? {} }),
    put: <T = any>(p: string, body?: unknown) => call<T>('PUT', p, { token, body: body ?? {} }),
    patch: <T = any>(p: string, body?: unknown) => call<T>('PATCH', p, { token, body: body ?? {} }),
    del: <T = any>(p: string) => call<T>('DELETE', p, { token }),
  }
}

/** Sem login, ou com token de API (X-Api-Token). */
export const anon = {
  get: <T = any>(p: string, apiToken?: string) => call<T>('GET', p, { apiToken }),
  post: <T = any>(p: string, body: unknown, apiToken?: string) => call<T>('POST', p, { apiToken, body }),
}

// ── Contas: provisiona pelo login real e promove pelo fluxo real ───────────
for (const who of ['master', 'admin', 'editor', 'editor2', 'viewer', 'viewer2'] as const) {
  const r = await as(who).get('/api/v1/auth/me')
  if (r.status !== 200) throw new Error(`login de ${who} falhou: ${r.status} ${JSON.stringify(r.body)}`)
}
for (const who of ['editor', 'editor2'] as const) {
  const r = await as('admin').patch(`/api/v1/admin/users/${encodeURIComponent(USERS[who])}/role`, { role: 'editor' })
  if (r.status !== 200) throw new Error(`promover ${who} falhou: ${r.status} ${JSON.stringify(r.body)}`)
}

// ── Conjuntos de teste ─────────────────────────────────────────────────────
export interface SeedField { key: string; type?: 'text' | 'number' | 'date' | 'bool'; sensitive?: boolean; hidden?: boolean }
export interface SeedDataset {
  slug: string
  visibility?: 'tenant' | 'private'
  owner?: Who
  fields: SeedField[]
  /** SELECT que produz as linhas (colunas = keys dos campos). */
  rowsSql: string
}

/**
 * Conjunto de FONTE já sincronizado: linha no catálogo, campos com as marcas
 * de sensível/oculto e o Parquet no lake — o estado que uma carga deixaria.
 */
export async function seedDataset(d: SeedDataset): Promise<string> {
  const tenant = (await db.query(`select id from tenants where slug = 'sebratel'`)).rows[0]
  const ds = (await db.query(
    `insert into datasets (tenant_id, connection_id, schema_name, object_name, slug, name,
                           visibility, owner_email, sync_mode, kind, row_count, last_sync_at)
     values ($1, 'teste', 'public', $2, $2, $3, $4, $5, 'snapshot', 'source', 0, now())
     returning id`,
    [tenant.id, d.slug, `TESTE-COMITE ${d.slug}`, d.visibility ?? 'tenant', d.owner ? USERS[d.owner] : null],
  )).rows[0]
  for (const [i, f] of d.fields.entries()) {
    await db.query(
      `insert into dataset_fields (dataset_id, source_column, key, label, type, hidden, sensitive, sort_order)
       values ($1, $2, $2, $2, $3, $4, $5, $6)`,
      [ds.id, f.key, f.type ?? 'text', !!f.hidden, !!f.sensitive, i],
    )
  }
  const dir = join(lakeRoot, 'sebratel', d.slug)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'part-1.parquet').replace(/\\/g, '/')
  await duckQuery(`copy (${d.rowsSql}) to '${file}' (format parquet)`)
  return String(ds.id)
}

/** Fecha servidor e banco e apaga o lake de teste. Chamar no after() de cada arquivo. */
export async function shutdown(): Promise<void> {
  await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) })
  await closeAllPools()
  await db.end()
  const admin = new pg.Client({ ...config.datahubDb, database: 'postgres' })
  await admin.connect()
  await admin.query(`drop database if exists ${TEST_DB} with (force)`)
  await admin.end()
  rmSync(work, { recursive: true, force: true })
}
