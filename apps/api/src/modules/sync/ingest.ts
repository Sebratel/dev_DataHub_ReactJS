// ─────────────────────────────────────────────────────────────────────────
// Ingestão generalista fonte → lake (Parquet). Regras de carga (docs §9.1):
//   • UMA sincronização por vez em todo o hub (fila sequencial global);
//   • lotes de SYNC_BATCH_SIZE com pausa de SYNC_BATCH_PAUSE_MS entre eles;
//   • incremental por watermark (keyset — nunca OFFSET em modo incremental);
//   • SELECT simples de colunas, sem regra de negócio (guard read-only).
// O lote vai para JSONL temporário; no fim, o DuckDB converte para Parquet.
// ─────────────────────────────────────────────────────────────────────────
import { createWriteStream, unlinkSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../../core/config.js'
import { db } from '../../db/pool.js'
import { getConnector } from '../../connectors/registry.js'
import { querySource } from '../../connectors/pools.js'
import { fetchHttpPages, type HttpEndpoint, type HttpPagination, type PageMetric } from '../../connectors/httpSource.js'
import { datasetDir, parquetGlob, clearParquet, dirBytes, uploadToGcs, listParquet, stagingDir } from '../../core/lake.js'
import { duckQuery } from '../query/duck.js'
import { materializeDerived, referencedSlugs } from '../transform/derive.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Progresso ao vivo: grava o parcial em sync_runs.rows a cada lote. O painel de
// sync já lê essa coluna a cada 2s, então o contador sobe na tela em vez de
// ficar em 0 até o fim. Não-fatal: um erro aqui não derruba a sincronização.
async function reportProgress(runId: string, rows: number): Promise<void> {
  try {
    await db.query(`update sync_runs set rows = $2 where id = $1`, [runId, rows])
  } catch { /* progresso é best-effort */ }
}

// Grava as métricas de chamada da API (Fase 2 — observabilidade). Best-effort:
// falha aqui não afeta a sincronização. endpoint = caminho estável (p/ agrupar).
async function flushApiMetrics(slug: string, connectionId: string, endpoint: string, metrics: PageMetric[]): Promise<void> {
  if (!metrics.length) return
  try {
    for (const m of metrics) {
      await db.query(
        `insert into api_call_metrics (dataset_slug, connection_id, endpoint, status, ok, duration_ms, rows, bytes, error)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [slug, connectionId, endpoint, m.status, m.status >= 200 && m.status < 400, m.ms, m.rows, m.bytes,
         m.status >= 400 ? `HTTP ${m.status}` : null],
      )
    }
  } catch (e) {
    console.warn(`[api-metrics] falha ao gravar métricas de ${slug}: ${(e as Error).message}`)
  }
}

// Cancelamento COOPERATIVO: a carga em andamento verifica este sinal entre os
// lotes e para de forma limpa (descarta o temporário, mantém os dados antigos).
// Só uma carga roda por vez (fila sequencial), então basta rastrear a atual.
const cancelRequested = new Set<string>()
let runningDatasetId: string | null = null
class SyncCancelled extends Error {
  constructor() { super('Sincronização cancelada pelo usuário.'); this.name = 'SyncCancelled' }
}
// Pede para parar. Retorna true se havia uma carga em andamento para o dataset.
export function requestCancel(datasetId: string): boolean {
  if (runningDatasetId !== datasetId) return false
  cancelRequested.add(datasetId)
  return true
}

// JSON.stringify seguro para valores vindos dos drivers (BigInt, Date).
function jsonLine(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_k, v) => {
    if (typeof v === 'bigint') return v <= Number.MAX_SAFE_INTEGER ? Number(v) : v.toString()
    return v
  })
}

// Fila sequencial global — dois datasets jamais sincronizam ao mesmo tempo,
// nem em fontes diferentes (prioridade absoluta: não pesar na produção).
let queue: Promise<unknown> = Promise.resolve()

// `visited` evita ciclo infinito quando A cascateia para B e B (por engano)
// cascateia de volta para A — cada slug só dispara cascata uma vez por corrida.
export function enqueueSync(datasetId: string, visited: Set<string> = new Set()): Promise<string> {
  const job = queue.then(() => runSync(datasetId)).catch((e) => {
    console.error(`[sync] falha: ${(e as Error).message}`)
    return `erro: ${(e as Error).message}`
  })
  queue = job

  // A cascata dispara DEPOIS que `job` resolve, fora da cadeia atribuída a
  // `queue`. Isto é o que evita o deadlock: se estivesse dentro da mesma
  // cadeia, um dependente tentando se enfileirar na MESMA fila que ainda não
  // terminou de resolver ficaria esperando por si mesmo para sempre.
  void job.then((result) => {
    if (typeof result === 'string' && !result.startsWith('erro:')) {
      void cascadeToDependents(datasetId, visited).catch((e) =>
        console.warn(`[sync] cascata a partir de ${datasetId} falhou: ${(e as Error).message}`))
    }
  })

  return job as Promise<string>
}

// Depois de UM dataset (fonte ou derivado) sincronizar com sucesso, recalcula
// na hora qualquer derivado com cadência 'cascade' que o referencie no
// transform_sql — em vez de esperar o próximo tick de hora/dia bater.
//
// O corte de ciclo (visited) precisa acontecer ANTES de enfileirar o
// dependente, não depois: checar só no início desta função (depois que o
// dependente já rodou) deixava um ciclo A->B->A executar A DUAS vezes antes de
// perceber a repetição na segunda chamada. Checando aqui, o segundo caminho
// nunca chega a chamar enqueueSync — para uma iteração mais cedo.
async function cascadeToDependents(datasetId: string, visited: Set<string>): Promise<void> {
  const ds = (await db.query(`select slug, tenant_id from datasets where id = $1`, [datasetId])).rows[0]
  if (!ds) return
  const slug = String(ds.slug)
  visited.add(slug) // o próprio dataset que acabou de rodar entra no conjunto

  const rows = (await db.query(
    `select id, slug, transform_sql from datasets
      where tenant_id = $1 and kind = 'derived' and sync_cadence = 'cascade'`,
    [ds.tenant_id],
  )).rows
  const dependents = rows.filter((r) => referencedSlugs(String(r.transform_sql ?? ''), [slug]).includes(slug))
  for (const dep of dependents) {
    const depSlug = String(dep.slug)
    if (visited.has(depSlug)) {
      console.warn(`[sync] cascata interrompida: ciclo de dependência envolvendo "${depSlug}".`)
      continue
    }
    console.log(`[sync] cascata: "${slug}" atualizou -> recalculando "${depSlug}".`)
    await enqueueSync(String(dep.id), visited)
  }
}

// Reescreve o conjunto de Parquets mantendo, para cada identidade (dedupeKeys),
// apenas a linha MAIS RECENTE — o "upsert" que o lake não tinha. Devolve o
// arquivo final.
//
// A ordem das operações importa: o compactado entra ANTES de as partes antigas
// saírem. O inverso (limpar e depois renomear) abre uma janela em que o conjunto
// fica vazio em disco — uma queda do processo ali perde o dado. Nesta ordem, o
// pior caso de uma queda no meio é o conjunto ficar com linhas repetidas até a
// próxima compactação, que conserta sozinha. Perder dado não conserta.
export async function compactLake(
  dir: string, dedupeKeys: string[], recencyKeys: string[], runId: string,
): Promise<string> {
  const ident = (s: string) => `"${String(s).replace(/"/g, '""')}"`
  const partition = dedupeKeys.map(ident).join(', ')
  const recency = recencyKeys.length > 1
    ? `greatest(${recencyKeys.map(ident).join(', ')})`
    : recencyKeys.length === 1 ? ident(recencyKeys[0]) : 'NULL'
  // Extensão .tmp de propósito: fica FORA do glob *.parquet, senão o próprio
  // read_parquet desta consulta leria o arquivo que ela ainda está escrevendo.
  const tmp = join(dir, `compact-${runId}.tmp`).replace(/\\/g, '/')
  await duckQuery(
    `copy (
       select * exclude (__rn) from (
         select *, row_number() over (
           partition by ${partition} order by ${recency} desc nulls last
         ) as __rn
         from read_parquet('${parquetGlob(dir)}')
       ) where __rn = 1
     ) to '${tmp}' (format parquet, compression zstd)`,
  )
  const final = join(dir, `part-compacted-${runId}.parquet`)
  renameSync(tmp, final)
  clearParquet(dir, final)
  return final
}

async function runSync(datasetId: string): Promise<string> {
  const ds = (await db.query(
    `select d.*, t.slug as tenant_slug from datasets d
      join tenants t on t.id = d.tenant_id where d.id = $1`,
    [datasetId],
  )).rows[0]
  if (!ds) throw new Error('Dataset não encontrado.')

  // Derivado: não toca em fonte nenhuma — materializa SQL sobre o lake.
  if (ds.kind === 'derived') {
    return materializeDerived({
      id: String(ds.id), slug: String(ds.slug),
      tenantSlug: String(ds.tenant_slug), transformSql: ds.transform_sql as string | null,
    })
  }

  const def = getConnector(String(ds.connection_id))
  if (!def) throw new Error(`Fonte desconhecida: ${ds.connection_id}`)

  const mode = ds.sync_mode === 'incremental' && ds.incremental_key ? 'incremental' : 'snapshot'
  // Incremental SEM watermark NENHUM = recomeço (primeira carga ou modo trocado):
  // é uma carga completa e deve SUBSTITUIR as partes antigas, não acrescentar.
  const replaceParts = mode === 'snapshot' || (ds.watermark == null && ds.watermark_2 == null)
  const run = (await db.query(
    `insert into sync_runs (dataset_id, mode) values ($1, $2) returning id`,
    [datasetId, mode],
  )).rows[0]

  const fields = (await db.query(
    `select source_column, key, type from dataset_fields where dataset_id = $1 order by sort_order`,
    [datasetId],
  )).rows
  // Drivers devolvem BIGINT/NUMERIC como STRING (precisão) — sem coerção o
  // Parquet nasceria VARCHAR e quebraria filtros/agregações numéricas.
  const numericKeys = fields.filter((f) => f.type === 'number').map((f) => String(f.key))
  function coerce(row: Record<string, unknown>): Record<string, unknown> {
    for (const k of numericKeys) {
      const v = row[k]
      if (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))) row[k] = Number(v)
    }
    return row
  }
  const q = def.kind === 'mysql'
    ? (s: string) => '`' + String(s).replace(/`/g, '') + '`'
    : (s: string) => '"' + String(s).replace(/"/g, '') + '"'
  // SELECT generalista: coluna física → nome exposto (key). Nada de negócio.
  const cols = fields.map((f) => `${q(f.source_column)} as ${q(f.key)}`).join(', ')
  const from = `${q(ds.schema_name)}.${q(ds.object_name)}`

  const dir = datasetDir(String(ds.tenant_slug), String(ds.slug))
  // Staging no volume do lake (disco real), não no /tmp do container.
  const jsonl = join(stagingDir(), `datahub-sync-${run.id}.jsonl`)
  const stream = createWriteStream(jsonl, { encoding: 'utf8' })
  const write = (line: string) => new Promise<void>((res, rej) =>
    stream.write(line + '\n', (e) => (e ? rej(e) : res())))

  let total = 0
  const apiMetrics: PageMetric[] = [] // fontes http: latência/status por chamada
  // Um watermark POR CHAVE: as duas passadas avançam independentes uma da outra
  // (o maior "created" visto não diz nada sobre o maior "modified").
  let newWatermark: string | null = ds.watermark ?? null
  let newWatermark2: string | null = ds.watermark_2 ?? null
  const { batchSize, batchPauseMs, maxRows } = config.sync
  // Disjuntor: aborta antes de a carga em fuga derrubar o servidor.
  const guardRunaway = () => {
    if (maxRows && total > maxRows) {
      throw new Error(
        `Sincronização abortada: excedeu ${maxRows.toLocaleString('pt-BR')} linhas (SYNC_MAX_ROWS). ` +
        `Provável carga em fuga — use modo incremental com "Publicar a partir de".`,
      )
    }
  }
  // Checkpoint de cancelamento (entre lotes).
  const checkCancel = () => { if (cancelRequested.has(datasetId)) throw new SyncCancelled() }
  runningDatasetId = datasetId

  try {
    if (def.kind === 'http') {
      // Fonte HTTP (API GET): pagina e escreve cada lote no MESMO JSONL. Reusa
      // disjuntor, cancelamento e progresso. Trata-se como recarga completa.
      const sc = (ds.source_config ?? {}) as Record<string, unknown>
      const ep: HttpEndpoint = {
        baseUrl: def.http?.baseUrl ?? '',
        path: String(sc.path ?? ''),
        query: (sc.query as Record<string, string> | undefined) ?? undefined,
        recordsPath: sc.recordsPath ? String(sc.recordsPath) : undefined,
        auth: { header: def.http?.authHeader, scheme: def.http?.authScheme, token: def.http?.token },
        pagination: (sc.pagination as HttpPagination | undefined) ?? { style: 'none' },
      }
      for await (const batch of fetchHttpPages(ep, { pauseMs: batchPauseMs, timeoutMs: config.sources.statementTimeoutMs }, (m) => apiMetrics.push(m))) {
        for (const row of batch) await write(jsonLine(coerce(row)))
        total += batch.length
        guardRunaway()
        checkCancel()
        await reportProgress(run.id, total)
      }
    } else if (mode === 'incremental') {
      const ph = def.kind === 'mysql' ? '?' : '$1'

      // Piso da PRIMEIRA carga (sem watermark ainda): data fixa ("publicar a
      // partir de 01/01/2025") ou RELATIVA ("últimos N dias"), esta resolvida
      // agora, a cada execução. A relativa é o que torna "tudo que foi criado
      // ou editado hoje" expressável sem alguém reeditar a data à mão.
      const floor: string | null = ds.sync_since != null
        ? String(ds.sync_since)
        : ds.sync_since_days != null
          ? new Date(Date.now() - Number(ds.sync_since_days) * 86_400_000).toISOString()
          : null

      // Folga de reconferência: rebobina o watermark N minutos. Sem ela, uma
      // edição que chega com carimbo ANTERIOR ao watermark (transação longa,
      // relógio da fonte atrasado) fica para trás do corte e some para sempre.
      // Só faz sentido em chave de data — em chave numérica, subtrair minutos
      // não significa nada, então passa direto.
      const lagged = (mark: string, isDate: boolean): string => {
        const lag = Number(ds.watermark_lag_minutes ?? 0)
        if (!lag || !isDate) return mark
        const t = new Date(mark)
        if (Number.isNaN(t.getTime())) return mark
        return new Date(t.getTime() - lag * 60_000).toISOString()
      }

      // UMA passada keyset sobre UMA chave: WHERE key {>|>=} $bound ORDER BY key
      // LIMIT n — nunca OFFSET. Escreve no MESMO JSONL das demais (as passadas
      // somam) e devolve o watermark novo da sua chave.
      const keysetPass = async (exposedKey: string, storedWatermark: string | null): Promise<string | null> => {
        const field = fields.find((f) => f.key === exposedKey)
        const keyCol = field?.source_column ?? exposedKey
        const isDate = String(field?.type) === 'date'
        let cursor: { op: '>' | '>='; val: string } | null = storedWatermark != null
          ? { op: '>', val: lagged(storedWatermark, isDate) }
          : floor != null
            ? { op: '>=', val: floor }
            : null
        let last: string | null = null // maior valor visto NESTA passada
        for (;;) {
          // "is not null" explícito: uma passada keyset só consegue avançar
          // sobre valores não nulos. Sem isto, uma carga sem piso nem watermark
          // traz as linhas de chave NULL no fim da ordenação e grava a string
          // "null" como watermark — e o lote seguinte compara data com o texto
          // 'null'. Linha de chave nula não se perde: ela entra pela OUTRA
          // passada (é exatamente o caso do modified vazio).
          const where = cursor
            ? `where ${q(keyCol)} is not null and ${q(keyCol)} ${cursor.op} ${ph}`
            : `where ${q(keyCol)} is not null`
          const sql = `select ${cols} from ${from} ${where} order by ${q(keyCol)} limit ${batchSize}`
          const { rows } = await querySource(String(ds.connection_id), sql, cursor ? [cursor.val] : [])
          for (const row of rows) await write(jsonLine(coerce(row)))
          total += rows.length
          if (rows.length) {
            const v = rows[rows.length - 1][exposedKey]
            const s = v instanceof Date ? v.toISOString() : String(v)
            // Trava anti-loop: um lote CHEIO cujo cursor NÃO avançou significa
            // que a chave não está progredindo (valor repetido/não extraído) e a
            // carga releria as MESMAS linhas para sempre (foi o que bateu 86,7M
            // e encheu o disco). Aborta com erro claro em vez de fugir.
            if (rows.length === batchSize && s === last) {
              throw new Error(
                `Sincronização incremental não convergiu: a chave "${exposedKey}" não avançou entre lotes ` +
                `(valor "${s}" repetido em um lote cheio). A chave precisa ser CRESCENTE e única o ` +
                `suficiente — verifique o campo escolhido ou use uma chave única (ex.: id).`,
              )
            }
            last = s
            cursor = { op: '>', val: s }
          }
          guardRunaway()
          checkCancel()
          await reportProgress(run.id, total) // progresso ao vivo na tela
          if (rows.length < batchSize) break
          await sleep(batchPauseMs) // respiro para a fonte entre lotes
        }
        // A leitura é ascendente e SEM teto, então o último valor visto é o maior
        // da fonte para esta chave — pode virar watermark direto. Sem linha
        // nenhuma, preserva o antigo: a folga não pode fazer o progresso andar
        // para trás.
        return last ?? storedWatermark
      }

      // DUAS passadas, uma por chave — e não um order by greatest(created,
      // modified) na fonte, que não usa índice e viraria varredura completa da
      // tabela a cada lote, contra a produção, a cada 5 minutos. Cada passada
      // ordena pela SUA coluna e continua indexada. Elas se sobrepõem de
      // propósito (linha criada E editada na janela vem nas duas); quem resolve
      // a repetição é a compactação por dedupe_keys, mais abaixo.
      newWatermark = await keysetPass(String(ds.incremental_key), newWatermark)
      if (ds.incremental_key_2) {
        newWatermark2 = await keysetPass(String(ds.incremental_key_2), newWatermark2)
      }
    } else {
      // Snapshot paginado. OFFSET SEM ORDER BY pode reler/pular linhas e, com
      // escritas concorrentes, NUNCA convergir — foi o que inflou para 77M e
      // encheu o disco. Ordenamos pela 1ª coluna ordenável: estabiliza a
      // paginação e garante que, ao passar do fim, o loop termine. (Tabela
      // grande: prefira incremental — OFFSET tardio ainda pesa na fonte.)
      const orderCol = fields.find((f) => ['number', 'date', 'text'].includes(String(f.type)))?.source_column
      const orderBy = orderCol ? `order by ${q(orderCol)}` : ''
      for (let offset = 0; ; offset += batchSize) {
        const sql = `select ${cols} from ${from} ${orderBy} limit ${batchSize} offset ${offset}`
        const { rows } = await querySource(String(ds.connection_id), sql)
        for (const row of rows) await write(jsonLine(coerce(row)))
        total += rows.length
        guardRunaway()
        checkCancel()
        await reportProgress(run.id, total)
        if (rows.length < batchSize) break
        await sleep(batchPauseMs)
      }
    }
    await new Promise<void>((res, rej) => stream.end((e: unknown) => (e ? rej(e) : res())))

    // JSONL → Parquet (zstd). Snapshot substitui as partes; incremental acrescenta.
    if (total > 0) {
      const part = join(dir, `part-${run.id}.parquet`).replace(/\\/g, '/')
      // Schema DECLARADO (não auto-inferido): lemos cada coluna com um tipo
      // seguro e convertemos com try_cast (NULL em vez de erro). Sem isto, o
      // read_json_auto adivinha o tipo e ESTOURA em valores fora do padrão —
      // ex.: coluna MySQL TIME com duração negativa ("-00:00:14"). Datas viram
      // texto e depois try_cast p/ TIMESTAMP; texto/duração ficam preservados.
      const sqlit = (s: string) => `'${String(s).replace(/'/g, "''")}'`
      const ident = (s: string) => `"${String(s).replace(/"/g, '""')}"`
      const readType = (t: string) =>
        t === 'number' ? 'DOUBLE' : t === 'bool' ? 'BOOLEAN' : t === 'json' ? 'JSON' : 'VARCHAR'
      const cols = (fields as { key: string; type: string }[])
        .map((f) => `${sqlit(f.key)}: '${readType(f.type)}'`).join(', ')
      const selectList = (fields as { key: string; type: string }[]).map((f) => {
        const k = ident(f.key)
        if (f.type === 'date') return `try_cast(${k} as TIMESTAMP) as ${k}` // datas/timestamps; TIME/duração vira NULL
        if (f.type === 'json') return `cast(${k} as VARCHAR) as ${k}`
        return k
      }).join(', ')
      const src = fields.length
        ? `read_json(${sqlit(jsonl.replace(/\\/g, '/'))}, columns={${cols}}, format='newline_delimited')`
        : `read_json_auto('${jsonl.replace(/\\/g, '/')}')` // sem campos: fallback improvável
      await duckQuery(`copy (select ${selectList || '*'} from ${src}) to '${part}' (format parquet, compression zstd)`)
      if (replaceParts) clearParquet(dir, join(dir, `part-${run.id}.parquet`))

      // UPSERT no lake. Sem isto, a linha reeditada CONVIVE com a versão antiga
      // (o incremental acrescenta uma parte e nada remove a anterior), e as duas
      // passadas ainda trazem a mesma linha duas vezes de propósito. A
      // compactação é o que transforma "só acrescenta" em "atualiza ou cria".
      const dedupeKeys = ((ds.dedupe_keys as string[] | null) ?? []).filter(Boolean)
      if (mode === 'incremental' && dedupeKeys.length) {
        // Quem vence quando a mesma identidade aparece duas vezes: a data mais
        // recente entre as chaves incrementais — é o "quando o modified for
        // maior que o created, vale o modified". O greatest do DuckDB IGNORA
        // NULL (como o Postgres, ao contrário do MySQL), então o created sozinho
        // já decide quando o modified é vazio, que é a maioria das linhas.
        const recency = [ds.incremental_key, ds.incremental_key_2].filter(Boolean).map(String)
        const final = await compactLake(dir, dedupeKeys, recency, String(run.id))
        await uploadToGcs(final, String(ds.tenant_slug), String(ds.slug))
      } else {
        await uploadToGcs(part, String(ds.tenant_slug), String(ds.slug))
      }
    }

    // Contagem oficial vem do lake (fonte não é retocada).
    const count = listParquet(dir).length
      ? Number((await duckQuery(`select count(*) as n from read_parquet('${parquetGlob(dir)}')`)).rows[0]?.n ?? 0)
      : 0

    await db.query(
      `update datasets set row_count = $2, last_sync_at = now(), watermark = $3, watermark_2 = $4,
                          updated_at = now() where id = $1`,
      [datasetId, count, newWatermark, newWatermark2],
    )
    await db.query(
      `update sync_runs set status = 'done', rows = $2, bytes = $3, finished_at = now() where id = $1`,
      [run.id, total, dirBytes(dir)],
    )
    console.log(`[sync] ${ds.slug}: ${mode}, ${total} linha(s) novas, total no lake ${count}.`)
    return `ok: ${total} linha(s)`
  } catch (e) {
    const cancelled = e instanceof SyncCancelled
    await db.query(
      `update sync_runs set status = $2, rows = $3, error = $4, finished_at = now() where id = $1`,
      [run.id, cancelled ? 'cancelled' : 'error', total, cancelled ? null : (e as Error).message],
    )
    if (cancelled) {
      // Temporário descartado no finally; Parquet antigo permanece intacto.
      console.log(`[sync] ${ds.slug}: cancelado (${total} linha(s) lidas descartadas).`)
      return 'cancelado'
    }
    throw e
  } finally {
    stream.destroy()
    if (existsSync(jsonl)) unlinkSync(jsonl)
    cancelRequested.delete(datasetId)
    runningDatasetId = null
    // Observabilidade: grava as métricas das chamadas HTTP (mesmo se a carga
    // falhou/foi cancelada — a última chamada, inclusive com erro, é registrada).
    if (def.kind === 'http') {
      await flushApiMetrics(String(ds.slug), String(ds.connection_id), String(ds.object_name), apiMetrics)
    }
  }
}
