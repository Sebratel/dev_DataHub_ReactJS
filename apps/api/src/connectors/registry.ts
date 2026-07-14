// ─────────────────────────────────────────────────────────────────────────
// Registro declarativo das fontes de dados. As credenciais vêm do .env pelo
// prefixo (DB_<PREFIXO>_HOST/PORT/DATABASE/USER/PASSWORD) — mesmo formato do
// churn_mvp, então o .env existente funciona sem alteração.
// Credencial NUNCA vai para o banco de metadados nem para o frontend.
// ─────────────────────────────────────────────────────────────────────────

export type ConnectorKind = 'postgres' | 'mysql' | 'soap' | 'gcs'

export interface ConnectorDef {
  id: string
  name: string
  kind: ConnectorKind
  envPrefix: string // ex.: DB_ELLEVEN → DB_ELLEVEN_HOST etc.
}

export const CONNECTORS: ConnectorDef[] = [
  { id: 'elleven', name: 'ELLEVEN (ERP)', kind: 'postgres', envPrefix: 'DB_ELLEVEN' },
  { id: 'radius', name: 'RADIUS', kind: 'postgres', envPrefix: 'DB_RADIUS' },
  { id: 'autoisp', name: 'AutoISP (ONU/PPPoE)', kind: 'postgres', envPrefix: 'DB_AUTOISP' },
  { id: 'maria', name: 'Massivas (MariaDB)', kind: 'mysql', envPrefix: 'DB_MARIA' },
  // SOAP (RH) e GCS entram no módulo sync — não são fontes SQL navegáveis.
]

export function getConnector(id: string): ConnectorDef | undefined {
  return CONNECTORS.find((c) => c.id === id)
}

// Uma fonte está "configurada" quando as 4 variáveis mínimas existem no .env.
export function isConfigured(def: ConnectorDef): boolean {
  return ['HOST', 'DATABASE', 'USER', 'PASSWORD']
    .every((suffix) => !!process.env[`${def.envPrefix}_${suffix}`])
}
