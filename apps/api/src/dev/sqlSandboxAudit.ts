// Auditoria do SQL JÁ SALVO contra o validador do SEG-01 — rodar ANTES do
// deploy da correção, no servidor (ou com o .env apontando para produção).
//
// A validação nova (compileLakeSql) é mais estrita que a lista de palavras de
// antes: aceita só conjuntos citados pelo slug/apelido, CTEs próprias e
// range/generate_series/unnest. Um calculado salvo há meses que use outra
// função de tabela (json_each, por exemplo) passaria a falhar na próxima
// materialização — em silêncio, de madrugada. Isto lista quem cairia, para
// corrigir o SQL antes, e não descobrir pelo painel parado.
//
// SOMENTE LEITURA: lê o banco de metadados, valida no DuckDB e imprime. Não
// executa o SQL de ninguém nem escreve nada.
//
// Uso: npx tsx src/dev/sqlSandboxAudit.ts   (exit 1 se algum seria recusado)
import { db } from '../db/pool.js'
import { assertSafeLakeSql, lakeRefs, validateTransformSql } from '../modules/transform/derive.js'

interface Item { kind: string; tenant: string; name: string; sql: string; excludeSlug?: string }

const items: Item[] = []

for (const r of (await db.query(
  `select t.slug as tenant, d.slug, d.name, d.transform_sql
     from datasets d join tenants t on t.id = d.tenant_id
    where d.kind = 'derived' and coalesce(d.transform_sql, '') <> ''`,
)).rows) {
  items.push({ kind: 'calculado', tenant: r.tenant, name: `${r.name} (${r.slug})`, sql: r.transform_sql, excludeSlug: r.slug })
}

for (const r of (await db.query(
  `select t.slug as tenant, m.slug, m.name, m.feature_sql
     from ml_models m join tenants t on t.id = m.tenant_id
    where coalesce(m.feature_sql, '') <> ''`,
)).rows) {
  items.push({ kind: 'modelo ML', tenant: r.tenant, name: `${r.name} (${r.slug})`, sql: r.feature_sql })
}

// Notebooks executam só quando alguém clica — não quebram nada de madrugada,
// mas o dono vai ver a célula recusada. Entram como informação.
for (const r of (await db.query(
  `select t.slug as tenant, n.slug, n.name, n.owner_email, n.cells
     from notebooks n join tenants t on t.id = n.tenant_id`,
)).rows) {
  const cells = Array.isArray(r.cells) ? r.cells as Array<{ kind?: string; source?: string; name?: string }> : []
  cells.forEach((c, i) => {
    if (c.kind === 'sql' && String(c.source ?? '').trim()) {
      items.push({
        kind: 'notebook', tenant: r.tenant,
        name: `${r.name} (${r.slug}) › célula ${c.name || i + 1} · ${r.owner_email}`, sql: String(c.source),
      })
    }
  })
}

const refsCache = new Map<string, Awaited<ReturnType<typeof lakeRefs>>>()
let recusados = 0
let quebradosAntes = 0
for (const it of items) {
  const key = `${it.tenant}|${it.excludeSlug ?? ''}`
  if (!refsCache.has(key)) refsCache.set(key, await lakeRefs(it.tenant, { excludeSlug: it.excludeSlug }))
  const refs = refsCache.get(key)!
  // Separa o que JÁ era recusado (lista de palavras antiga) do que a regra
  // nova passa a recusar — só o segundo grupo é efeito desta correção.
  try { validateTransformSql(it.sql) } catch (e) {
    quebradosAntes++
    console.log(`  já recusado antes  [${it.kind}] ${it.name}\n      ${(e as Error).message}`)
    continue
  }
  try {
    await assertSafeLakeSql(it.sql, refs)
  } catch (e) {
    recusados++
    console.log(` PASSA A SER RECUSADO [${it.kind}] ${it.name}\n      ${(e as Error).message}`)
  }
}

console.log(
  `\n${items.length} SQL(s) auditado(s): ${items.length - recusados - quebradosAntes} ok, ` +
  `${recusados} passariam a ser recusados, ${quebradosAntes} já eram recusados antes.`,
)
await db.end()
process.exit(recusados ? 1 : 0)
