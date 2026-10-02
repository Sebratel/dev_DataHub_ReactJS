// ─────────────────────────────────────────────────────────────────────────
// Ingestão generalista fonte → lake (Parquet). Regras de carga (docs §9.1):
//   • UMA sincronização por vez em todo o hub (fila sequencial global);
//   • lotes de SYNC_BATCH_SIZE com pausa de SYNC_BATCH_PAUSE_MS entre eles;
//   • incremental por watermark (keyset — nunca OFFSET em modo incremental);
//   • SELECT simples de colunas, sem regra de negócio (guard read-only).
// O lote vai para JSONL temporário; no fim, o DuckDB converte para Parquet.
// ─────────────────────────────────────────────────────────────────────────
import { createWriteStream, unlinkSync, existsSync, renameSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { createGzip } from 'node:zlib'
import { join } from 'node:path'
import { config } from '../../core/config.js'
import { db } from '../../db/pool.js'
import { getConnector } from '../../connectors/registry.js'
import { querySource } from '../../connectors/pools.js'
import { fetchHttpPages, type HttpEndpoint, type HttpPagination, type PageMetric } from '../../connectors/httpSource.js'
import {
  datasetDir, parquetGlob, clearParquet, dirBytes, uploadToGcs, listParquet, stagingDir,
  partEmEscrita, concluiParte, descartaParte,
} from '../../core/lake.js'
import { duckQuery } from '../query/duck.js'
import { materializeDerived, referencedSlugs } from '../transform/derive.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// O disjuntor olha UMA passada, não o total da execução.
//
// Numa carga completa com duas chaves o motor lê a tabela DUAS vezes (uma por
// `created`, outra por `modified`) e as duas somam. Uma tabela de 15,9 milhões
// fecha ~31,7 milhões de leituras legítimas, e estourava um teto de 30 milhões
// dimensionado para "a maior tabela + folga". Por passada, uma carga em fuga
// (ilimitada) continua sendo pega e uma carga legítima passa.
export function excedeTeto(lidasNaPassada: number, maxRows: number): boolean {
  return maxRows > 0 && lidasNaPassada > maxRows
}

// Data no formato que as FONTES entendem: 'AAAA-MM-DD HH:MM:SS.mmm' em hora
// LOCAL, sem sufixo de fuso.
//
// `toISOString()` não serve para isto, e o motivo é traiçoeiro: ele devolve UTC
// com `Z`, e tanto o Postgres quanto o MySQL IGNORAM o `Z` ao comparar com uma
// coluna `timestamp`/`datetime` — leem o horário como se já fosse local. Num
// fuso -03 isso joga o corte 3 horas no FUTURO, e todas as linhas criadas nesse
// intervalo deixam de ser lidas, sem erro nenhum.
export function timestampLocal(d: Date): string {
  const p = (n: number, casas = 2) => String(n).padStart(casas, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

// Watermark gravado ANTES da correção de fuso: veio de `toISOString()` e está
// em UTC ('...T18:10:35.684Z'), portanto 3 horas à frente do que a coluna
// contém. Enquanto ficar assim, o conjunto não lê mais nada até o relógio real
// alcançá-lo. Reescreve para hora local na leitura; a gravação do fim da
// execução já sai no formato novo, então cada conjunto se acerta numa execução.
const ISO_COM_FUSO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/
export function normalizaWatermark(mark: string | null): string | null {
  if (mark == null || !ISO_COM_FUSO.test(mark)) return mark
  const t = new Date(mark)
  return Number.isNaN(t.getTime()) ? mark : timestampLocal(t)
}

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

// Fecha execuções que ficaram penduradas em 'running'.
//
// Um run só sai de 'running' quando o código chega ao fim — sucesso ou erro. Se
// o PROCESSO morre no meio (deploy, restart do container, falta de memória),
// ninguém atualiza a linha e ela fica 'running' para sempre. O estrago é maior
// do que uma linha feia no histórico:
//
//   • a tela do conjunto passa a mostrar "Sincronizando…" eternamente, e o
//     botão de sincronizar fica desabilitado — o conjunto parece travado;
//   • a fila de sincronização conta essas linhas como "rodando agora", o que
//     contradiz a regra de UMA por vez e mostra tempos absurdos (um run de
//     agosto aparece com "1384h" de duração).
//
// No BOOT não há execução em andamento por definição: o processo acabou de
// subir e a fila está vazia. Então toda linha em 'running' neste instante é
// órfã, e pode ser fechada com segurança. Mesmo espírito do cleanStaging().
export async function closeOrphanRuns(): Promise<number> {
  const r = await db.query(
    `update sync_runs set status = 'error', finished_at = now(),
            error = coalesce(error, 'Interrompida: o servidor reiniciou durante a execução ' ||
                                    '(deploy, restart do container ou falta de memória). ' ||
                                    'Os dados anteriores do conjunto continuam intactos.')
      where status = 'running'`,
  )
  return r.rowCount ?? 0
}

// Quantas falhas seguidas até o agendador parar de tentar sozinho.
//
// Três, e não uma: erro transitório (rede oscilando, fonte reiniciando, tempo
// esgotado num pico) se resolve na tentativa seguinte, e pausar no primeiro
// tropeço criaria trabalho manual onde não havia problema. Três seguidas já não
// é azar — é um erro que vai se repetir igual, e insistir só custa leitura na
// produção.
const FALHAS_ATE_PAUSAR = 3

async function registraFalha(datasetId: string, slug: string, erro: string): Promise<void> {
  try {
    const r = (await db.query(
      `update datasets set sync_failures = sync_failures + 1, updated_at = now()
        where id = $1 returning sync_failures`,
      [datasetId],
    )).rows[0]
    const falhas = Number(r?.sync_failures ?? 0)
    if (falhas < FALHAS_ATE_PAUSAR) return

    const motivo =
      `Pausado automaticamente após ${falhas} falhas seguidas. Último erro: ${erro.slice(0, 300)} — ` +
      'insistir num erro que se repete só custa leitura na fonte de produção. Resolva a causa e use ' +
      '"Sincronizar agora" para retomar (qualquer ação manual reativa o agendamento).'
    await db.query(
      `update datasets set sync_paused_reason = $2 where id = $1 and sync_paused_reason is null`,
      [datasetId, motivo],
    )
    console.warn(`[sync] ${slug}: PAUSADO após ${falhas} falhas seguidas.`)
  } catch (e) {
    // Best-effort: não pode transformar uma falha de carga em duas.
    console.warn(`[sync] falha ao registrar erro de ${slug}: ${(e as Error).message}`)
  }
}

// Retoma um conjunto pausado. Chamado por toda ação HUMANA explícita — quem foi
// lá e mandou rodar acredita que o motivo mudou, e a máquina não deve discordar.
export async function resumeDataset(datasetId: string): Promise<void> {
  await db.query(
    `update datasets set sync_failures = 0, sync_paused_reason = null, updated_at = now()
      where id = $1 and sync_paused_reason is not null`,
    [datasetId],
  )
}

// Fila sequencial global — dois datasets jamais sincronizam ao mesmo tempo,
// nem em fontes diferentes (prioridade absoluta: não pesar na produção).
let queue: Promise<unknown> = Promise.resolve()

// Quem está ESPERANDO na fila. A fila em si é uma cadeia de promessas, que não
// dá para inspecionar — e sem esta lista não havia como responder "mandei
// recarregar 12 conjuntos, e agora?": o que já rodou aparece no histórico de
// cada um, mas o que ainda vai rodar não aparecia em lugar nenhum.
const aguardando: string[] = []
// Pedidos de cancelamento de quem AINDA não começou. A fila é uma cadeia de
// promessas: não dá para arrancar um elo dela, então o elo roda e consulta isto
// para desistir sem trabalho nenhum.
const canceladas = new Set<string>()

export function pendingSyncs(): string[] {
  return [...aguardando]
}

// Tira da fila quem ainda não começou. Sem `ids`, esvazia a fila inteira.
// Não toca em quem JÁ está rodando — para isso existe o cancelamento
// cooperativo (requestCancel), que interrompe entre os lotes.
export function cancelPending(ids?: string[]): string[] {
  const alvo = ids?.length ? ids : [...aguardando]
  const removidos: string[] = []
  for (const id of alvo) {
    const i = aguardando.indexOf(id)
    if (i >= 0) { aguardando.splice(i, 1); canceladas.add(id); removidos.push(id) }
  }
  return removidos
}

// `visited` evita ciclo infinito quando A cascateia para B e B (por engano)
// cascateia de volta para A — cada slug só dispara cascata uma vez por corrida.
export function enqueueSync(datasetId: string, visited: Set<string> = new Set()): Promise<string> {
  // JÁ na fila ou rodando: não entra de novo. Sem esta trava a fila se
  // multiplica sozinha, por dois caminhos independentes:
  //
  //   • o agendador roda a cada minuto e decide pelo `last_sync_at`, que só
  //     avança no FIM de uma execução bem-sucedida. Enquanto um conjunto espera
  //     numa fila longa, ele continua "vencido" e é enfileirado de novo a cada
  //     minuto — uma recarga de 3h rendia dezenas de cópias do mesmo conjunto;
  //   • a cascata enfileira cada calculado uma vez por FONTE que termina. Dez
  //     fontes sincronizando põem o mesmo calculado dez vezes na fila.
  //
  // O efeito não era só visual: cada cópia relê a tabela inteira de novo,
  // ocupando horas de fila para chegar ao mesmo resultado.
  if (aguardando.includes(datasetId) || runningDatasetId === datasetId) {
    return Promise.resolve('já estava na fila')
  }
  aguardando.push(datasetId)
  const job = queue.then(() => {
    // Sai da espera no instante em que COMEÇA a rodar — daí em diante quem
    // conta a história é o sync_run, com status 'running'.
    const i = aguardando.indexOf(datasetId)
    if (i >= 0) aguardando.splice(i, 1)
    // Tirado da fila enquanto esperava: desiste sem tocar na fonte.
    if (canceladas.delete(datasetId)) {
      console.log(`[sync] ${datasetId}: retirado da fila antes de começar.`)
      return 'retirado da fila'
    }
    return runSync(datasetId)
  }).catch((e) => {
    const i = aguardando.indexOf(datasetId)
    if (i >= 0) aguardando.splice(i, 1)
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

// Compactar vale a pena? Duas perguntas baratas antes de um trabalho caro.
//
// A compactação lê TODAS as colunas do conjunto, recomprime e regrava. Num
// agendamento de 5 em 5 minutos isso é o conjunto inteiro reescrito até 288
// vezes por dia — e na maioria das vezes o lote trouxe só linhas NOVAS, sem
// nenhuma identidade repetida para colapsar. Reescrever ali é gastar disco,
// CPU e I/O do servidor para chegar exatamente ao mesmo conteúdo.
//
// Compacta quando:
//   • existe identidade repetida (houve edição, ou as duas passadas trouxeram
//     a mesma linha) — aí a compactação é o que mantém o dado correto; ou
//   • o conjunto passou do teto de arquivos: sem isso, pular a compactação
//     trocaria um problema pelo outro — 288 Parquets pequenos por dia deixam
//     TODA leitura do conjunto mais lenta, para sempre.
//
// A sondagem lê só as colunas de identidade. Num Parquet (colunar) isso é uma
// fração do custo de reescrever o conjunto: é por isso que perguntar antes sai
// mais barato que fazer sempre.
async function compactionNeeded(
  dir: string, dedupeKeys: string[], parts: number,
): Promise<{ needed: boolean; why: string }> {
  if (parts > config.sync.compactMaxParts) {
    return { needed: true, why: `${parts} arquivos (teto: ${config.sync.compactMaxParts})` }
  }
  const ident = (s: string) => `"${String(s).replace(/"/g, '""')}"`
  const group = dedupeKeys.map(ident).join(', ')
  const { rows } = await duckQuery(
    `select 1 as dup from read_parquet('${parquetGlob(dir)}')
      group by ${group} having count(*) > 1 limit 1`,
  )
  return rows.length
    ? { needed: true, why: 'há identidade repetida para colapsar' }
    : { needed: false, why: 'nenhuma identidade repetida' }
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
// Uma chave incremental identifica a linha; NEM TODA identifica um INSTANTE.
// Quando a tabela de origem não tem coluna de criação, o hub usa o `id`
// numérico como 1ª chave ("linha nova = id maior"). Juntar esse `id` com a 2ª
// chave num `greatest(id, updated_at)` é comparar número com data: o DuckDB
// recusa a consulta inteira ("Cannot combine types of DOUBLE and TIMESTAMP") e
// a compactação — logo, a sincronização — falha em toda execução.
//
// E, mesmo que o banco aceitasse, não faria sentido: `id` não é um instante,
// então ordenar por "o maior entre um id e uma data" não diz qual versão da
// linha é a mais recente.
//
// Regra: quem decide recência são as chaves TEMPORAIS. Havendo alguma, só elas
// entram. Não havendo nenhuma (tabela sem data de espécie alguma), usa a
// primeira chave sozinha — aí não há o que comparar, e uma coluna só nunca
// mistura tipo com ninguém.
export interface RecencyKey { key: string; isDate: boolean }

export function recencyExpression(keys: RecencyKey[]): string {
  const ident = (s: string) => `"${String(s).replace(/"/g, '""')}"`
  const datas = keys.filter((k) => k.isDate)
  const usadas = datas.length ? datas : keys.slice(0, 1)
  if (!usadas.length) return 'NULL'
  // greatest() só entre colunas do MESMO tipo — é a regra que faltava.
  return usadas.length > 1
    ? `greatest(${usadas.map((k) => ident(k.key)).join(', ')})`
    : ident(usadas[0].key)
}

export async function compactLake(
  dir: string, dedupeKeys: string[], recencyKeys: RecencyKey[], runId: string,
): Promise<string> {
  const ident = (s: string) => `"${String(s).replace(/"/g, '""')}"`
  const partition = dedupeKeys.map(ident).join(', ')
  const recency = recencyExpression(recencyKeys)
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
  // Staging COMPRIMIDO. Medido numa amostra com cara de tabela de ERP: o JSONL
  // cru fica ~91x o tamanho do Parquet final e ~25x o do mesmo JSONL em gzip.
  // Como o arquivo vive do começo ao fim da carga, ele — e não o Parquet — é o
  // que faz o disco subir por horas e desabar quando a carga termina; era o
  // "dente de serra" no gráfico do servidor.
  //
  // O DuckDB lê `.jsonl.gz` com a MESMA chamada read_json (descompressão é
  // transparente), então só o caminho de escrita muda.
  //
  // Nível 1 de propósito: a ingestão já é o gargalo, e a diferença de tamanho
  // entre o nível 1 e o máximo não paga o custo de CPU em milhões de linhas.
  const jsonl = join(stagingDir(), `datahub-sync-${run.id}.jsonl.gz`)
  const arquivo = createWriteStream(jsonl)
  const gzip = createGzip({ level: 1 })
  gzip.pipe(arquivo)
  // Bytes ANTES de comprimir — conferidos contra o rodapé do gzip no fim para
  // detectar arquivo cortado (ver abaixo).
  let bytesCrus = 0
  const write = (line: string) => new Promise<void>((res, rej) => {
    const chunk = line + '\n'
    bytesCrus += Buffer.byteLength(chunk)
    gzip.write(chunk, (e) => (e ? rej(e) : res()))
  })

  let total = 0
  // Custo da compactação desta execução — gravado no run para que "o que está
  // pesando no servidor?" tenha resposta por medição, não por suposição.
  let compacted = false
  let compactMs: number | null = null
  const apiMetrics: PageMetric[] = [] // fontes http: latência/status por chamada
  // Um watermark POR CHAVE: as duas passadas avançam independentes uma da outra
  // (o maior "created" visto não diz nada sobre o maior "modified").
  let newWatermark: string | null = ds.watermark ?? null
  let newWatermark2: string | null = ds.watermark_2 ?? null
  const { batchSize, batchPauseMs, maxRows } = config.sync
  // Disjuntor: aborta antes de a carga em fuga derrubar o servidor.
  //
  // O teto vale POR PASSADA, não pelo total da execução — e a diferença não é
  // detalhe. Numa carga completa com duas chaves, o motor lê a tabela DUAS
  // vezes (uma por `created`, outra por `modified`) e as duas somam. Uma tabela
  // de 15,9 milhões de linhas fecha ~31,7 milhões de LEITURAS, todas
  // legítimas — e estourava um teto de 30 milhões dimensionado para "a maior
  // tabela + folga", porque ninguém contou com a duplicação.
  //
  // O resultado era pior que uma carga recusada: o conjunto entrava em laço.
  // Toda tentativa lia a fonte por horas, abortava no mesmo ponto e recomeçava
  // no ciclo seguinte — 7 varreduras por dia contra o ERP de produção, para
  // nunca concluir.
  //
  // Por passada o disjuntor continua fazendo o que foi feito para fazer: uma
  // carga EM FUGA (OFFSET relendo, keyset que não avança) é ilimitada e estoura
  // igual. Uma carga legítima é limitada a N por passada, e passa. O pior caso
  // fica em 2×SYNC_MAX_ROWS no total, que continua sendo um teto.
  const guardRunaway = (lidasNaPassada: number, passada: string) => {
    if (excedeTeto(lidasNaPassada, maxRows)) {
      throw new Error(
        `Sincronização abortada: a passada por "${passada}" leu mais de ` +
        `${maxRows.toLocaleString('pt-BR')} linhas (SYNC_MAX_ROWS). ` +
        'Numa carga completa cada chave lê a tabela inteira, então o teto precisa caber na MAIOR ' +
        'tabela, não na soma das passadas. Se a tabela realmente tem mais linhas que isso, aumente ' +
        'SYNC_MAX_ROWS; se não tem, a chave não está avançando e a leitura está em fuga.',
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
        guardRunaway(total, 'paginação da API')
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
          ? timestampLocal(new Date(Date.now() - Number(ds.sync_since_days) * 86_400_000))
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
        return timestampLocal(new Date(t.getTime() - lag * 60_000))
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
        // Contador desta passada, separado do `total` da execução: é ele que o
        // disjuntor olha. O `total` continua somando as duas, porque é quantas
        // linhas foram de fato escritas no staging.
        let lidasNestaPassada = 0
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
          lidasNestaPassada += rows.length
          if (rows.length) {
            const v = rows[rows.length - 1][exposedKey]
            // Os drivers entregam data como TEXTO (MySQL por `dateStrings`,
            // Postgres pelo override de tipos em pools.ts), então o caminho
            // normal é `String(v)`. O ramo do Date fica como rede de segurança
            // para qualquer driver futuro — e formata em hora LOCAL, nunca com
            // `toISOString()`: em UTC o watermark voltaria a ficar 3h à frente
            // da coluna e o corte pularia linhas em silêncio.
            const s = v instanceof Date ? timestampLocal(v) : String(v)
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
          guardRunaway(lidasNestaPassada, exposedKey)
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
      newWatermark = await keysetPass(String(ds.incremental_key), normalizaWatermark(newWatermark))
      if (ds.incremental_key_2) {
        newWatermark2 = await keysetPass(String(ds.incremental_key_2), normalizaWatermark(newWatermark2))
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
        guardRunaway(total, 'snapshot')
        checkCancel()
        await reportProgress(run.id, total)
        if (rows.length < batchSize) break
        await sleep(batchPauseMs)
      }
    }
    // Espera o ARQUIVO terminar, não o gzip: `gzip.end()` só empurra o que
    // falta pelo transform; quem sabe que tudo chegou ao disco é o 'finish' do
    // destino final.
    await new Promise<void>((res, rej) => {
      arquivo.on('finish', () => res())
      arquivo.on('error', rej)
      gzip.on('error', rej)
      gzip.end()
    })

    // O staging está completo? O gzip termina com um rodapé de 8 bytes cujos
    // últimos 4 são o TAMANHO DESCOMPRIMIDO (mod 2^32). Comparando com o que
    // escrevemos, um arquivo cortado no meio — disco cheio, processo morto,
    // volume que sumiu — é pego aqui, com o nome certo.
    //
    // Sem esta conferência, quem aparece depois é um erro de descompressão ou
    // do DuckDB ("maximum_object_size exceeded"), que mandam procurar no lugar
    // errado: a suspeita recai sobre o tamanho de uma linha, e o problema é
    // disco. Já aconteceu.
    if (total > 0) {
      const bytes = statSync(jsonl).size
      if (bytes < 18) { // cabeçalho (10) + rodapé (8) de um gzip vazio
        throw new Error(
          `Arquivo de staging incompleto: ${bytes} bytes, sem nem o rodapé do gzip. ` +
          'A escrita foi interrompida logo no começo — quase sempre falta de espaço em disco.',
        )
      }
      const fd = openSync(jsonl, 'r')
      try {
        const rodape = Buffer.alloc(4)
        readSync(fd, rodape, 0, 4, bytes - 4)
        const declarado = rodape.readUInt32LE(0)
        if (declarado !== (bytesCrus >>> 0)) {
          throw new Error(
            `Arquivo de staging incompleto: escrevemos ${bytesCrus.toLocaleString('pt-BR')} bytes, ` +
            `mas o arquivo fechou com ${declarado.toLocaleString('pt-BR')}. A escrita foi interrompida no ` +
            'meio — quase sempre falta de espaço em disco no volume do lake. Libere espaço e sincronize ' +
            'de novo; o conteúdo antigo do conjunto continua intacto.',
          )
        }
      } finally { closeSync(fd) }
    }

    // JSONL → Parquet (zstd). Snapshot substitui as partes; incremental acrescenta.
    if (total > 0) {
      // Mesma trava do calculado: escreve com sufixo .writing e só renomeia no
      // fim. Três execuções recentes desta plataforma morreram com "o servidor
      // reiniciou durante a execução" — cada uma delas, aqui, deixava para trás
      // um Parquet truncado capaz de derrubar toda leitura do conjunto.
      const parte = partEmEscrita(dir, String(run.id))
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
      // maximum_object_size: teto do DuckDB para UMA linha do JSONL, que aqui é
      // UMA linha da tabela. O padrão dele é 16 MB e derruba a conversão
      // inteira quando alguma linha passa disso — uma tabela de ERP com coluna
      // de texto grande basta. O erro que aparece ("maximum_object_size
      // exceeded") não diz que o problema é UMA linha específica, e manda
      // procurar no lugar errado.
      const src = fields.length
        ? `read_json(${sqlit(jsonl.replace(/\\/g, '/'))}, columns={${cols}}, format='newline_delimited', ` +
          `maximum_object_size=${config.sync.maxJsonObjectBytes})`
        : `read_json_auto('${jsonl.replace(/\\/g, '/')}')` // sem campos: fallback improvável
      try {
        await duckQuery(`copy (select ${selectList || '*'} from ${src}) to '${parte.tmpDuck}' (format parquet, compression zstd)`)
        concluiParte(parte)
      } catch (e) {
        descartaParte(parte)
        throw e
      }
      if (replaceParts) clearParquet(dir, parte.final)

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
        //
        // O TIPO de cada chave viaja junto: uma 1ª chave numérica (tabela sem
        // coluna de criação) não pode entrar no greatest ao lado de uma data.
        // Ver recencyExpression.
        const tipoDe = new Map(fields.map((f) => [String(f.key), String(f.type)]))
        const recency: RecencyKey[] = [ds.incremental_key, ds.incremental_key_2]
          .filter(Boolean).map(String)
          .map((key) => ({ key, isDate: tipoDe.get(key) === 'date' }))
        const check = await compactionNeeded(dir, dedupeKeys, listParquet(dir).length)
        if (check.needed) {
          const t0 = Date.now()
          const final = await compactLake(dir, dedupeKeys, recency, String(run.id))
          compactMs = Date.now() - t0
          compacted = true
          console.log(`[sync] ${ds.slug}: compactado em ${compactMs} ms (${check.why}).`)
          await uploadToGcs(final, String(ds.tenant_slug), String(ds.slug))
        } else {
          console.log(`[sync] ${ds.slug}: compactação dispensada (${check.why}).`)
          await uploadToGcs(parte.final, String(ds.tenant_slug), String(ds.slug))
        }
      } else {
        await uploadToGcs(parte.final, String(ds.tenant_slug), String(ds.slug))
      }
    }

    // Contagem oficial vem do lake (fonte não é retocada).
    const count = listParquet(dir).length
      ? Number((await duckQuery(`select count(*) as n from read_parquet('${parquetGlob(dir)}')`)).rows[0]?.n ?? 0)
      : 0

    await db.query(
      // last_full_reload_at só avança quando a fonte foi lida INTEIRA
      // (replaceParts) — carga completa, snapshot ou recarga explícita. É o que
      // permite a tela responder "este conjunto ainda precisa ser recarregado?"
      // em vez de só "ele foi afetado?": sem esta marca, o contador de
      // pendentes nunca baixava por mais que se recarregasse.
      `update datasets set row_count = $2, last_sync_at = now(), watermark = $3, watermark_2 = $4,
                          last_full_reload_at = case when $5 then now() else last_full_reload_at end,
                          -- Deu certo: a sequência de falhas acabou.
                          sync_failures = 0, sync_paused_reason = null,
                          updated_at = now() where id = $1`,
      [datasetId, count, newWatermark, newWatermark2, replaceParts],
    )
    await db.query(
      `update sync_runs set status = 'done', rows = $2, bytes = $3, finished_at = now(),
                           compacted = $4, compact_ms = $5, parts = $6 where id = $1`,
      [run.id, total, dirBytes(dir), compacted, compactMs, listParquet(dir).length],
    )
    console.log(`[sync] ${ds.slug}: ${mode}, ${total} linha(s) novas, total no lake ${count}.`)
    return `ok: ${total} linha(s)`
  } catch (e) {
    const cancelled = e instanceof SyncCancelled
    // Cancelamento não conta como falha: foi alguém pedindo para parar.
    if (!cancelled) await registraFalha(datasetId, String(ds.slug), (e as Error).message)
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
    gzip.destroy()
    arquivo.destroy()
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
