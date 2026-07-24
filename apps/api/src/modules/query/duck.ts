// DuckDB embutido — motor de consulta do lake. Instância única em memória com
// LIMITES de proteção (memória, threads, spill em disco); cada consulta usa uma
// conexão própria. Consultas interativas passam um timeout: ao estourar, a
// conexão é interrompida (interrupt) e o usuário recebe erro claro — assim uma
// query pesada de um time não trava o hub para todos.
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api'
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
}

// ── Limitador de concorrência (semáforo FIFO) ──────────────────────────────
// No máximo `maxConcurrency` consultas executam ao mesmo tempo; o excedente
// espera na fila. Protege o servidor de um pico (dashboard com muitos widgets,
// vários usuários) sem derrubar nada — só serializa o excesso. O sync roda uma
// por vez em background, então ocupa no máximo um slot.
const MAX_CONCURRENCY = config.duck.maxConcurrency
let active = 0
const waiters: Array<() => void> = []

function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENCY) { active++; return Promise.resolve() }
  return new Promise<void>((resolve) => waiters.push(resolve))
}
function releaseSlot(): void {
  const next = waiters.shift()
  if (next) next() // passa o slot adiante sem zerar o contador
  else active--
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
  // Espera um slot: o timeout da consulta só começa a contar quando ela de fato
  // executa (abaixo), não enquanto aguarda na fila.
  await acquireSlot()
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
    releaseSlot()
  }
}
