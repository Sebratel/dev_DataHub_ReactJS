// ─────────────────────────────────────────────────────────────────────────
// Registro das fontes de dados. Dois tipos:
//   • FIXAS (.env): declaradas em CONNECTORS, credenciais por prefixo
//     (DB_<PREFIXO>_HOST/PORT/DATABASE/USER/PASSWORD). Não editáveis pela tela.
//   • GERENCIADAS (banco): cadastradas na tela; carregadas do banco de metadados
//     com a senha JÁ descriptografada em memória (campo `config`). Ver store.ts.
// Credencial NUNCA vai para o frontend.
// ─────────────────────────────────────────────────────────────────────────

export type ConnectorKind = 'postgres' | 'mysql' | 'soap' | 'gcs'

export interface ConnectorConfig {
  host: string
  port: number
  database: string
  user: string
  password: string
  ssl: boolean
}

export interface ConnectorDef {
  id: string
  name: string
  kind: ConnectorKind
  envPrefix?: string        // fontes FIXAS (.env)
  config?: ConnectorConfig  // fontes GERENCIADAS (banco, descriptografada em memória)
  managed?: boolean         // true = veio da tela (editável/removível)
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

export function allConnectors(): ConnectorDef[] {
  return [...CONNECTORS, ...dynamic.values()]
}

export function getConnector(id: string): ConnectorDef | undefined {
  return CONNECTORS.find((c) => c.id === id) ?? dynamic.get(id)
}

// Uma fonte está "configurada" quando dá para conectar: gerenciada tem config;
// fixa precisa das 4 variáveis mínimas no .env.
export function isConfigured(def: ConnectorDef): boolean {
  if (def.config) return true
  if (!def.envPrefix) return false
  return ['HOST', 'DATABASE', 'USER', 'PASSWORD']
    .every((suffix) => !!process.env[`${def.envPrefix}_${suffix}`])
}
