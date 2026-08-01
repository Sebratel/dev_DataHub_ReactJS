// ─────────────────────────────────────────────────────────────────────────
// Registro das fontes de dados. Dois tipos:
//   • FIXAS (.env): declaradas em CONNECTORS, credenciais por prefixo
//     (DB_<PREFIXO>_HOST/PORT/DATABASE/USER/PASSWORD). Não editáveis pela tela.
//   • GERENCIADAS (banco): cadastradas na tela; carregadas do banco de metadados
//     com a senha JÁ descriptografada em memória (campo `config`). Ver store.ts.
// Credencial NUNCA vai para o frontend.
// ─────────────────────────────────────────────────────────────────────────

export type ConnectorKind = 'postgres' | 'mysql' | 'http' | 'soap' | 'gcs'

export interface ConnectorConfig {
  host: string
  port: number
  database: string
  user: string
  password: string
  ssl: boolean
}

// Config de uma fonte HTTP (API GET). token já descriptografado em memória.
export interface HttpConnConfig {
  baseUrl: string
  authHeader?: string // ex.: 'Authorization' | 'x-api-key'
  authScheme?: string // ex.: 'Bearer'; vazio = valor cru
  token?: string
}

export interface ConnectorDef {
  id: string
  name: string
  kind: ConnectorKind
  envPrefix?: string          // fontes FIXAS (.env)
  config?: ConnectorConfig    // fontes SQL GERENCIADAS (banco, descriptografada)
  http?: HttpConnConfig       // fontes HTTP GERENCIADAS
  managed?: boolean           // true = veio da tela (editável/removível)
}

export const CONNECTORS: ConnectorDef[] = [
  { id: 'elleven', name: 'ELLEVEN (ERP)', kind: 'postgres', envPrefix: 'DB_ELLEVEN' },
  { id: 'radius', name: 'RADIUS', kind: 'postgres', envPrefix: 'DB_RADIUS' },
  { id: 'autoisp', name: 'AutoISP (ONU/PPPoE)', kind: 'postgres', envPrefix: 'DB_AUTOISP' },
  { id: 'maria', name: 'Massivas (MariaDB)', kind: 'mysql', envPrefix: 'DB_MARIA' },
  // Banco de metadados do próprio hub — fonte DEMO em dev e auditoria em prod.
  { id: 'datahub-meta', name: 'Metadados do Hub (demo)', kind: 'postgres', envPrefix: 'DATAHUB_DB' },
  // SOAP (RH) e GCS entram no módulo sync — não são fontes SQL navegáveis.
]

// IDs reservados (fixos) — uma conexão gerenciada não pode colidir com eles.
export const RESERVED_IDS = new Set(CONNECTORS.map((c) => c.id))

// Conectores gerenciados (carregados do banco). Mapa em memória, recarregado no
// boot e após cada mutação (ver store.reloadConnections).
const dynamic = new Map<string, ConnectorDef>()

export function setDynamicConnectors(defs: ConnectorDef[]): void {
  dynamic.clear()
  for (const d of defs) dynamic.set(d.id, { ...d, managed: true })
}

// Uma conexão GERENCIADA com o mesmo id SOBREPÕE a nativa (.env). Assim dá para
// "personalizar" uma fonte fixa pela tela; excluir a sobreposição volta ao .env.
export function allConnectors(): ConnectorDef[] {
  const byId = new Map<string, ConnectorDef>()
  for (const c of CONNECTORS) byId.set(c.id, c)
  for (const [id, d] of dynamic) byId.set(id, d) // dynamic sobrepõe
  return [...byId.values()]
}

export function getConnector(id: string): ConnectorDef | undefined {
  return dynamic.get(id) ?? CONNECTORS.find((c) => c.id === id) // dynamic tem prioridade
}

// Detalhe (sem senha) de uma fonte fixa a partir do .env — para a tela
// pré-preencher o formulário de edição. undefined se não configurada.
export function envDetail(def: ConnectorDef): { host: string; port: number; database: string; username: string; ssl: boolean } | undefined {
  if (!def.envPrefix) return undefined
  const g = (s: string) => process.env[`${def.envPrefix}_${s}`]
  if (!g('HOST')) return undefined
  return {
    host: g('HOST')!, port: Number(g('PORT')) || (def.kind === 'mysql' ? 3306 : 5432),
    database: g('DATABASE') ?? '', username: g('USER') ?? '', ssl: g('SSL') === 'true',
  }
}

// Senha do .env de uma fonte fixa (para semear ao personalizar pela 1ª vez).
export function envPassword(id: string): string | undefined {
  const def = CONNECTORS.find((c) => c.id === id)
  return def?.envPrefix ? process.env[`${def.envPrefix}_PASSWORD`] : undefined
}

// Uma fonte está "configurada" quando dá para conectar: gerenciada tem config;
// fixa precisa das 4 variáveis mínimas no .env.
export function isConfigured(def: ConnectorDef): boolean {
  if (def.kind === 'http') return !!def.http?.baseUrl
  if (def.config) return true
  if (!def.envPrefix) return false
  return ['HOST', 'DATABASE', 'USER', 'PASSWORD']
    .every((suffix) => !!process.env[`${def.envPrefix}_${suffix}`])
}
