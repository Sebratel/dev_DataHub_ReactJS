// Guard de segurança para SQL de ingestão (portado do churn_mvp, validado em
// produção). Só statements de LEITURA passam. Defesa em profundidade — não
// substitui o usuário de banco somente-SELECT.

const FORBIDDEN = [
  'insert', 'update', 'delete', 'drop', 'alter', 'truncate', 'create',
  'grant', 'revoke', 'merge', 'copy', 'call', 'vacuum', 'comment',
  'reindex', 'cluster', 'lock', 'listen', 'notify', 'execute', 'into',
]

// Remove comentários e literais para a análise não disparar por texto quotado.
function stripNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:[^"])*"/g, '""')
}

export function checkReadOnly(sql: string): { ok: true } | { ok: false; reason: string } {
  if (typeof sql !== 'string' || !sql.trim()) return { ok: false, reason: 'SQL vazio.' }
  const clean = stripNoise(sql).toLowerCase()

  const firstWord = clean.trim().split(/[\s(]+/)[0]
  if (firstWord !== 'select' && firstWord !== 'with') {
    return { ok: false, reason: 'O SQL deve começar com SELECT ou WITH (somente leitura).' }
  }

  const withoutTrailing = clean.replace(/;\s*$/, '')
  if (withoutTrailing.includes(';')) {
    return { ok: false, reason: 'Múltiplos statements não são permitidos (";" no meio do SQL).' }
  }

  for (const kw of FORBIDDEN) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(clean)) {
      return { ok: false, reason: `Palavra não permitida no SQL: "${kw}". Apenas leitura (SELECT/WITH).` }
    }
  }
  return { ok: true }
}

export function assertReadOnly(sql: string): void {
  const r = checkReadOnly(sql)
  if (!r.ok) throw new Error(r.reason)
}
