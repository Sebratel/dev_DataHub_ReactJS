// Cria o catálogo, os schemas e o volume de chegada do piloto.
//
// Existe para que trocar de workspace (ou de NUVEM) seja um comando. O catálogo
// atual foi criado à mão, e isso só aparece como problema no dia em que é
// preciso recriá-lo — que é exatamente o dia em que ninguém lembra os nomes.
//
// Pela API do Unity Catalog, não por SQL: `CREATE CATALOG` exige um warehouse,
// e warehouse é compute. Numa conta sem crédito, o caminho por SQL nem existe —
// foi o que aconteceu na conta AWS em 18/10/2026.
//
// Idempotente: o que já existe é mantido, e o script diz o que achou.
//
// Uso: npm run databricks:setup-catalog --workspace apps/api
import { config } from '../core/config.js'

const CATALOGO = 'piloto_mariadb'
const SCHEMAS = ['landing', 'bronze', 'prata', 'ouro']
const VOLUME = 'arquivos'
const SCHEMA_VOLUME = 'landing'

const { host, token, clientId, clientSecret, oauthScope } = config.databricks
if (!host) { console.error('Defina DATABRICKS_HOST no .env.'); process.exit(1) }

// O provisionamento é administrativo: precisa de uma identidade que CRIE
// catálogo. O service principal do Data Hub, de propósito, não pode fazer isto
// — ele só escreve no volume. Por isso aqui o PAT vem primeiro.
async function credencial(): Promise<string> {
  if (token) return token
  if (!clientId || !clientSecret) throw new Error('Sem DATABRICKS_TOKEN nem CLIENT_ID/SECRET.')
  const r = await fetch(`https://${host}/oidc/v1/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(oauthScope)}`,
    signal: AbortSignal.timeout(30_000),
  })
  const d = (await r.json()) as { access_token?: string }
  if (!d.access_token) throw new Error(`Não obtive token OAuth (HTTP ${r.status}).`)
  return d.access_token
}
const tok = await credencial()

interface Resultado { criado: boolean; detalhe: string }

async function existe(caminho: string): Promise<boolean> {
  const r = await fetch(`https://${host}${caminho}`, {
    headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(60_000),
  })
  return r.ok
}

/**
 * Confere ANTES de criar, em vez de criar e tratar o 409.
 *
 * Não é preciosismo: a API valida o armazenamento do metastore antes de checar
 * se o objeto existe, então um catálogo que JÁ EXISTE volta como
 * `400 INVALID_STATE: Metastore storage root URL does not exist` — um erro que
 * fala de storage para descrever uma situação que não tem problema nenhum.
 * Quem lesse isso iria mexer em storage sem motivo.
 */
async function garantir(
  caminhoGet: string, caminhoPost: string, corpo: unknown, oQue: string,
): Promise<Resultado> {
  if (await existe(caminhoGet)) return { criado: false, detalhe: `${oQue} já existia` }
  const r = await fetch(`https://${host}${caminhoPost}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(60_000),
  })
  if (r.ok) return { criado: true, detalhe: `${oQue} criado` }
  const texto = await r.text()
  if (r.status === 409 || texto.includes('ALREADY_EXISTS')) {
    return { criado: false, detalhe: `${oQue} já existia` }
  }
  if (texto.includes('Metastore storage root URL does not exist')) {
    throw new Error(
      `${oQue}: o metastore não tem storage padrão para catálogo novo.\n`
      + '       Defina DATABRICKS_CATALOG_STORAGE_ROOT no .env (ex.: s3://bucket/caminho\n'
      + '       ou gs://bucket/caminho), ou crie o catálogo pela UI usando Default Storage.')
  }
  throw new Error(`${oQue}: HTTP ${r.status} — ${texto.slice(0, 250)}`)
}

// Alguns metastores exigem dizer ONDE o catálogo mora; outros têm storage
// padrão e recusam o campo. Por isso é opcional.
const storageRoot = (process.env.DATABRICKS_CATALOG_STORAGE_ROOT || '').trim()

console.log(`\nProvisionando em ${host}\n`)

const cat = await garantir(
  `/api/2.1/unity-catalog/catalogs/${CATALOGO}`,
  '/api/2.1/unity-catalog/catalogs',
  {
    name: CATALOGO,
    comment: 'Piloto Native/Matrix — chegada do Data Hub',
    ...(storageRoot ? { storage_root: storageRoot } : {}),
  },
  `catálogo ${CATALOGO}`)
console.log(`  ${cat.criado ? 'ok  ' : '·   '} ${cat.detalhe}`)

for (const s of SCHEMAS) {
  const r = await garantir(
    `/api/2.1/unity-catalog/schemas/${CATALOGO}.${s}`,
    '/api/2.1/unity-catalog/schemas',
    { name: s, catalog_name: CATALOGO }, `schema ${CATALOGO}.${s}`)
  console.log(`  ${r.criado ? 'ok  ' : '·   '} ${r.detalhe}`)
}

const vol = await garantir(
  `/api/2.1/unity-catalog/volumes/${CATALOGO}.${SCHEMA_VOLUME}.${VOLUME}`,
  '/api/2.1/unity-catalog/volumes',
  {
    catalog_name: CATALOGO, schema_name: SCHEMA_VOLUME, name: VOLUME,
    volume_type: 'MANAGED',
    comment: 'Chegada dos Parquet enviados pelo Data Hub',
  },
  `volume ${CATALOGO}.${SCHEMA_VOLUME}.${VOLUME}`)
console.log(`  ${vol.criado ? 'ok  ' : '·   '} ${vol.detalhe}`)

// Conferência: o estado final é o que importa, e ele se lê de volta.
console.log('\nConferindo o que existe agora:\n')
const r = await fetch(
  `https://${host}/api/2.1/unity-catalog/schemas?catalog_name=${CATALOGO}`,
  { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(60_000) })
const schemas = ((await r.json()) as { schemas?: Array<{ name: string }> }).schemas ?? []
const nomes = schemas.map((s) => s.name)
for (const s of SCHEMAS) {
  console.log(`  ${nomes.includes(s) ? 'ok  ' : 'FALTA'} ${CATALOGO}.${s}`)
}
const rv = await fetch(
  `https://${host}/api/2.1/unity-catalog/volumes/${CATALOGO}.${SCHEMA_VOLUME}.${VOLUME}`,
  { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(60_000) })
console.log(`  ${rv.ok ? 'ok  ' : 'FALTA'} volume ${CATALOGO}.${SCHEMA_VOLUME}.${VOLUME}`)

console.log('\nDepois disto: databricks:grants <applicationId> e databricks:setup-job.')
