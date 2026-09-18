// ─────────────────────────────────────────────────────────────────────────
// Reconciliar os campos publicados com as colunas que a fonte tem HOJE.
//
// O mapeamento campo→coluna é gravado na publicação e nunca mais conferido.
// Quando alguém renomeia ou remove uma coluna na origem, o conjunto passa a
// falhar em TODA execução — o SELECT da ingestão inclui a coluna que sumiu e o
// banco recusa a consulta inteira ("column ... does not exist"). O conjunto
// fica congelado, e até aqui não havia saída pela tela: `PATCH /fields/:id` só
// mexe em rótulo, tipo e visibilidade, nunca no `source_column`. A única
// alternativa era APAGAR e republicar o conjunto — perdendo concessões,
// métricas e tudo que aponta para o slug.
//
// Duas operações, ambas explícitas (nada roda sozinho):
//   • remover os campos cuja coluna não existe mais;
//   • publicar colunas novas que a fonte ganhou.
//
// Remover um campo mexe em mais coisa do que parece: se ele for a chave
// incremental, a 2ª chave ou parte da identidade da linha, deixar a
// configuração apontando para um campo que não existe mais quebraria a própria
// constraint do banco (a 2ª chave exige identidade não vazia). Por isso a
// limpeza da configuração acontece na MESMA transação.
// ─────────────────────────────────────────────────────────────────────────
import { db } from '../../db/pool.js'
import { discoverColumns } from '../../connectors/pools.js'

export interface ReconcileResult {
  removed: { key: string; sourceColumn: string }[]
  added: { key: string; sourceColumn: string }[]
  /** Configuração de sincronização que teve de ser zerada junto. */
  clearedConfig: string[]
  /** Avisos para quem clicou — o que pode ter quebrado em outro lugar. */
  warnings: string[]
}

function mapType(dataType: string): string {
  const dt = dataType.toLowerCase()
  if (/int|numeric|decimal|double|real|float|money/.test(dt)) return 'number'
  if (/bool/.test(dt)) return 'bool'
  if (/timestamp|datetime|date/.test(dt)) return 'date'
  if (/time/.test(dt)) return 'text' // TIME do MySQL é duração, não hora do dia
  if (/json/.test(dt)) return 'json'
  return 'text'
}

const labelize = (c: string) => c.replace(/[_-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())

export async function reconcileFields(
  datasetId: string, opts: { removeMissing: boolean; addColumns: string[] },
): Promise<ReconcileResult> {
  const ds = (await db.query(
    `select id, slug, connection_id, schema_name, object_name,
            incremental_key, incremental_key_2, dedupe_keys, sync_mode
       from datasets where id = $1 and kind <> 'derived'`,
    [datasetId],
  )).rows[0]
  if (!ds) throw new Error('Conjunto não encontrado (ou é calculado, que não tem colunas de fonte).')

  const cols = await discoverColumns(String(ds.connection_id), String(ds.schema_name), String(ds.object_name))
  const existentes = new Map(cols.map((c) => [c.name, c]))

  const fields = (await db.query(
    `select id, key, source_column, sort_order from dataset_fields where dataset_id = $1 order by sort_order`,
    [datasetId],
  )).rows
  const publicadas = new Set(fields.map((f) => String(f.source_column)))

  const sumidos = opts.removeMissing
    ? fields.filter((f) => !existentes.has(String(f.source_column)))
    : []
  // Só publica coluna que o chamador pediu E que existe E que ainda não está lá.
  const novas = opts.addColumns
    .filter((c) => existentes.has(c) && !publicadas.has(c))

  if (!sumidos.length && !novas.length) {
    return { removed: [], added: [], clearedConfig: [], warnings: ['Nada a reconciliar: os campos já batem com a fonte.'] }
  }

  const removedKeys = new Set(sumidos.map((f) => String(f.key)))
  const clearedConfig: string[] = []
  const warnings: string[] = []

  // Configuração que apontava para um campo que deixa de existir.
  const dedupeAtual = ((ds.dedupe_keys as string[] | null) ?? []).filter(Boolean)
  const dedupeNovo = dedupeAtual.filter((k) => !removedKeys.has(k))
  let key1: string | null = (ds.incremental_key as string | null) ?? null
  let key2: string | null = (ds.incremental_key_2 as string | null) ?? null
  if (key1 && removedKeys.has(key1)) { key1 = null; clearedConfig.push('chave incremental') }
  if (key2 && removedKeys.has(key2)) { key2 = null; clearedConfig.push('2ª chave incremental') }
  if (dedupeNovo.length !== dedupeAtual.length) {
    clearedConfig.push(`identidade da linha (${dedupeAtual.filter((k) => removedKeys.has(k)).join(', ')})`)
  }
  // A constraint do banco proíbe 2ª chave sem identidade — se a identidade
  // esvaziou, a 2ª chave cai junto, senão o UPDATE seria recusado.
  if (key2 && !dedupeNovo.length) {
    key2 = null
    clearedConfig.push('2ª chave incremental (ficou sem identidade da linha)')
  }
  // Sem chave incremental não existe modo incremental: volta a snapshot, que é
  // o comportamento correto e recarrega tudo na próxima execução.
  const modo = String(ds.sync_mode) === 'incremental' && !key1 ? 'snapshot' : String(ds.sync_mode)
  if (modo !== String(ds.sync_mode)) clearedConfig.push('modo (voltou para snapshot — ficou sem chave incremental)')

  const client = await db.connect()
  try {
    await client.query('begin')

    if (sumidos.length) {
      await client.query(
        `delete from dataset_fields where dataset_id = $1 and id = any($2::uuid[])`,
        [datasetId, sumidos.map((f) => String(f.id))],
      )
    }

    let ordem = fields.length
    for (const nome of novas) {
      const col = existentes.get(nome)!
      await client.query(
        `insert into dataset_fields (dataset_id, source_column, key, label, type, sort_order)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (dataset_id, source_column) do nothing`,
        [datasetId, nome, nome, labelize(nome), mapType(col.dataType), ordem++],
      )
    }

    if (clearedConfig.length) {
      // Zera o watermark junto: ele foi medido com a configuração antiga e,
      // aplicado à nova, pularia linhas que nunca chegaram ao lake.
      await client.query(
        `update datasets set sync_mode = $2, incremental_key = $3, incremental_key_2 = $4,
                             dedupe_keys = $5, watermark = null, watermark_2 = null, updated_at = now()
           where id = $1`,
        [datasetId, modo, key1, key2, dedupeNovo],
      )
    } else {
      await client.query(`update datasets set updated_at = now() where id = $1`, [datasetId])
    }

    await client.query('commit')
  } catch (e) {
    await client.query('rollback')
    throw e
  } finally {
    client.release()
  }

  if (sumidos.length) {
    warnings.push(
      'Os dados dessas colunas continuam no lake (nos Parquets antigos), mas deixam de ser lidos e somem na ' +
      'próxima recarga completa. Confira se algum painel, métrica ou conjunto calculado usava esses campos.',
    )
  }
  if (clearedConfig.length) {
    warnings.push('A próxima sincronização recomeça do zero: a configuração afetada foi zerada junto.')
  }

  return {
    removed: sumidos.map((f) => ({ key: String(f.key), sourceColumn: String(f.source_column) })),
    added: novas.map((n) => ({ key: n, sourceColumn: n })),
    clearedConfig, warnings,
  }
}
