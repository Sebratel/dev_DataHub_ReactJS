// DuckDB embutido — motor de consulta do lake. Instância única em memória com
// LIMITES de proteção (memória, threads, spill em disco); cada consulta usa uma
// conexão própria. Consultas interativas passam um timeout: ao estourar, a
// conexão é interrompida (interrupt) e o usuário recebe erro claro — assim uma
// query pesada de um time não trava o hub para todos.
import { DuckDBInstance, DuckDBConnection, JsonDuckDBValueConverter } from '@duckdb/node-api'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { config } from '../../core/config.js'

let instance: DuckDBInstance | null = null

async function getInstance(): Promise<DuckDBInstance> {
  if (!instance) {
    const spill = join(tmpdir(), 'datahub-duckdb-spill')
    try { mkdirSync(spill, { recursive: true }) } catch { /* já existe */ }
    instance = await DuckDBInstance.create(':memory:', {
      memory_limit: config.duck.memoryLimit,
      threads: String(config.duck.threads),
      // Spill em disco: ordenações/agregações grandes vão para disco em vez de
      // estourar a memória (degrada com elegância no lugar de OOM).
      temp_directory: spill,
    })
  }
  return instance
}

export interface DuckResult {
  columns: string[]
  rows: Record<string, unknown>[]
}

export interface DuckOptions {
  timeoutMs?: number // só nas consultas interativas; ausente = sem limite (background)
  /**
   * Carga AD-HOC — SQL livre de notebook, prévia de derivado, base de atributos
   * de modelo. Tem pista própria e menor.
   */
  adhoc?: boolean
  /** Pista explícita. Vence `adhoc`. */
  lane?: LaneName
}

export type LaneName = 'normal' | 'adhoc' | 'export'

function laneOf(opts: DuckOptions): Lane {
  return lanes[opts.lane ?? (opts.adhoc ? 'adhoc' : 'normal')]
}

// ── Limitador de concorrência (semáforo FIFO, em duas pistas) ──────────────
// No máximo `maxConcurrency` consultas executam ao mesmo tempo; o excedente
// espera na fila. Protege o servidor de um pico (dashboard com muitos widgets,
// vários usuários) sem derrubar nada — só serializa o excesso.
//
// Duas pistas porque as cargas têm formas diferentes: um painel dispara muitas
// consultas PEQUENAS e previsíveis; um notebook dispara UMA consulta grande e
// imprevisível. Numa fila só, três analistas explorando ocupariam todos os
// slots e os painéis de todo mundo entrariam atrás deles. A pista ad-hoc é
// menor de propósito: quem explora espera, quem consulta painel não trava.
const MAX_CONCURRENCY = config.duck.maxConcurrency
const MAX_ADHOC = config.duck.maxAdhocConcurrency

interface Lane { active: number; max: number; waiters: Array<() => void> }
// A pista de EXPORT é separada e estreita de propósito. Um export sem teto lê a
// tabela inteira e pode durar minutos; se dividisse fila com os notebooks,
// dois exports grandes deixariam os analistas esperando. Fila de 1 por vez: o
// segundo export espera, em vez de os dois brigarem por memória e I/O.
const lanes: Record<LaneName, Lane> = {
  normal: { active: 0, max: MAX_CONCURRENCY, waiters: [] },
  adhoc: { active: 0, max: MAX_ADHOC, waiters: [] },
  export: { active: 0, max: config.duck.maxExportConcurrency, waiters: [] },
}

function acquireSlot(lane: Lane): Promise<void> {
  if (lane.active < lane.max) { lane.active++; return Promise.resolve() }
  return new Promise<void>((resolve) => lane.waiters.push(resolve))
}
function releaseSlot(lane: Lane): void {
  const next = lane.waiters.shift()
  if (next) next() // passa o slot adiante sem zerar o contador
  else lane.active--
}

// Ocupação atual das pistas — para o painel de monitoramento e para diagnóstico.
export function engineLoad(): { normal: number; adhoc: number; queued: number } {
  return {
    normal: lanes.normal.active,
    adhoc: lanes.adhoc.active,
    queued: lanes.normal.waiters.length + lanes.adhoc.waiters.length,
  }
}

// Traduz erros do motor para mensagens acionáveis ao usuário.
function friendlyEngineError(e: Error): Error {
  const msg = e.message || ''
  if (/out of memory|memory_limit|failed to allocate|could not allocate/i.test(msg)) {
    return new Error(
      'A consulta exigiu mais memória que o limite do servidor. Reduza o volume ' +
      '(filtros, agrupamentos ou menos colunas) — ou peça a um administrador para aumentar DUCK_MEMORY_LIMIT.',
    )
  }
  return e
}

export async function duckQuery(
  sql: string, params: unknown[] = [], opts: DuckOptions = {},
): Promise<DuckResult> {
  // Espera um slot na pista certa: o timeout da consulta só começa a contar
  // quando ela de fato executa (abaixo), não enquanto aguarda na fila.
  const lane = laneOf(opts)
  await acquireSlot(lane)
  try {
    const conn: DuckDBConnection = await (await getInstance()).connect()
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    try {
      const run = conn.runAndReadAll(sql, params as never[])
      let reader
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            try { conn.interrupt() } catch { /* conexão pode já ter encerrado */ }
            reject(new Error(
              `A consulta excedeu o tempo limite de ${Math.round(opts.timeoutMs! / 1000)}s e foi cancelada. ` +
              'Refine com filtros ou reduza o intervalo de dados.',
            ))
          }, opts.timeoutMs)
        })
        try {
          reader = await Promise.race([run, timeout])
        } catch (e) {
          // Se estourou o tempo, espera o run abortar antes de fechar a conexão.
          if (timedOut) await run.catch(() => { /* rejeição esperada do interrupt */ })
          throw e
        }
      } else {
        reader = await run
      }
      return {
        columns: reader.columnNames(),
        rows: reader.getRowObjectsJson() as Record<string, unknown>[],
      }
    } catch (e) {
      throw friendlyEngineError(e as Error)
    } finally {
      if (timer) clearTimeout(timer)
      conn.closeSync()
    }
  } finally {
    releaseSlot(lane)
  }
}

// ── Leitura em STREAMING ─────────────────────────────────────────────────
// A diferença que importa: `duckQuery` materializa TODAS as linhas num array
// antes de devolver — ótimo para uma tela, fatal para um export de milhões de
// linhas, porque o pico de memória é proporcional ao resultado.
//
// Aqui o resultado é consumido em CHUNKS (o lote nativo do DuckDB, ~2048
// linhas). A memória fica constante seja o resultado de mil ou de cem milhões
// de linhas — o que sobe é só o tempo.
//
// `onChunk` é AGUARDADO: é por ali que a contrapressão da rede chega até o
// motor. Se o cliente lê devagar, paramos de buscar chunks em vez de acumular.
export interface StreamOptions extends DuckOptions {
  /** Consultado entre chunks; true encerra a leitura (cliente desconectou). */
  aborted?: () => boolean
}

export async function duckStream(
  sql: string,
  params: unknown[],
  onChunk: (rows: unknown[][], columns: string[]) => void | Promise<void>,
  opts: StreamOptions = {},
): Promise<{ columns: string[]; rowCount: number; aborted: boolean }> {
  const lane = laneOf({ ...opts, lane: opts.lane ?? 'export' })
  await acquireSlot(lane)
  try {
    const conn: DuckDBConnection = await (await getInstance()).connect()
    try {
      const result = await conn.stream(sql, params as never[])
      const columns = result.columnNames()
      let rowCount = 0
      let aborted = false

      for (;;) {
        if (opts.aborted?.()) {
          aborted = true
          // Interrompe a consulta no motor: sem isto o DuckDB seguiria
          // produzindo linhas para um cliente que já foi embora.
          try { conn.interrupt() } catch { /* já encerrada */ }
          break
        }
        const chunk = await result.fetchChunk()
        if (!chunk || chunk.rowCount === 0) break
        const rows = chunk.convertRows(JsonDuckDBValueConverter) as unknown[][]
        rowCount += rows.length
        await onChunk(rows, columns)
      }
      return { columns, rowCount, aborted }
    } catch (e) {
      throw friendlyEngineError(e as Error)
    } finally {
      conn.closeSync()
    }
  } finally {
    releaseSlot(lane)
  }
}
