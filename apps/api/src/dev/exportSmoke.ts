// Verificação do export sem teto: prova que a leitura em streaming mantém a
// memória CONSTANTE, e mede quanto a leitura materializada (a de antes) custa
// no mesmo dado.
//
// Este teste existe porque o `tsc` não tem opinião sobre memória: as duas
// versões compilam igual, e a diferença só aparece com volume. Rode com
//   npm run export:smoke --workspace apps/api
// e, para o número de heap ser confiável (GC determinístico):
//   node --expose-gc --import tsx src/dev/exportSmoke.ts
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { duckQuery, duckStream } from '../modules/query/duck.js'

const ROWS = Number(process.env.SMOKE_ROWS) || 2_000_000
const MB = (b: number) => `${(b / 1024 / 1024).toFixed(0)} MB`

const gc = (globalThis as { gc?: () => void }).gc
const heap = () => { gc?.(); return process.memoryUsage().heapUsed }

const dir = mkdtempSync(join(tmpdir(), 'datahub-export-smoke-'))
const parquet = join(dir, 'amostra.parquet').replace(/\\/g, '/')

let failures = 0
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FALHA'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

try {
  console.log(`\nGerando ${ROWS.toLocaleString('pt-BR')} linhas em Parquet…`)
  const t0 = Date.now()
  // Colunas variadas de propósito: texto, número, data e nulo exercitam a
  // conversão de valor, que é onde um export costuma quebrar.
  await duckQuery(
    `copy (
       select
         i as id,
         'cliente-' || i as nome,
         'CPF ' || (i * 7 % 99999999) as documento,
         (i % 997) * 1.37 as valor,
         date '2020-01-01' + interval (i % 2000) day as competencia,
         case when i % 11 = 0 then null else 'plano-' || (i % 7) end as plano,
         i % 2 = 0 as ativo
       from range(${ROWS}) t(i)
     ) to '${parquet}' (format parquet, compression zstd)`,
    [], { lane: 'export' },
  )
  console.log(`  arquivo: ${MB(statSync(parquet.replace(/\//g, process.platform === 'win32' ? '\\' : '/')).size)} em ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  const sql = `select * from read_parquet('${parquet}')`

  // ── 1. Streaming: memória constante ────────────────────────────────────
  console.log('\n1) duckStream — leitura em chunks')
  const base = heap()
  let peak = 0
  let chunks = 0
  let firstChunkMs = 0
  const t1 = Date.now()
  const r = await duckStream(sql, [], (rows) => {
    chunks++
    if (chunks === 1) firstChunkMs = Date.now() - t1
    // Simula o consumo real (montar a linha do CSV) para o custo ser honesto.
    for (const row of rows) row.map((v) => (v === null ? '' : String(v))).join(';')
    const used = process.memoryUsage().heapUsed - base
    if (used > peak) peak = used
  }, { lane: 'export' })
  const streamMs = Date.now() - t1

  console.log(`   linhas: ${r.rowCount.toLocaleString('pt-BR')} · chunks: ${chunks.toLocaleString('pt-BR')} · ${(streamMs / 1000).toFixed(1)}s`)
  console.log(`   1º chunk em ${firstChunkMs} ms (o download começa aqui)`)
  console.log(`   pico de heap acima da base: ${MB(peak)}`)

  check(r.rowCount === ROWS, 'todas as linhas saíram', `${r.rowCount} de ${ROWS}`)
  check(r.columns.length === 7, 'colunas preservadas', r.columns.join(', '))
  check(!r.aborted, 'terminou sem abortar')
  // O limite real é a memória ficar na casa das dezenas/centenas de MB em vez
  // de crescer com o resultado. 400 MB é folgado e ainda separa os dois mundos.
  check(peak < 400 * 1024 * 1024, 'memória constante (pico < 400 MB)', MB(peak))

  // ── 2. Materializado: o custo da versão antiga ─────────────────────────
  // Roda por último: se estourar o heap, os resultados acima já foram impressos.
  console.log('\n2) duckQuery — materializa tudo (o caminho antigo)')
  const base2 = heap()
  const t2 = Date.now()
  try {
    const all = await duckQuery(sql, [], { lane: 'export' })
    const used = process.memoryUsage().heapUsed - base2
    console.log(`   linhas: ${all.rows.length.toLocaleString('pt-BR')} · ${((Date.now() - t2) / 1000).toFixed(1)}s`)
    console.log(`   heap retido: ${MB(used)}`)
    const ratio = used / Math.max(peak, 1)
    console.log(`   → materializar custou ${ratio.toFixed(1)}× o streaming neste volume`)
    check(used > peak, 'materializar custa mais que streamar', `${MB(used)} vs ${MB(peak)}`)
  } catch (e) {
    // Estourar aqui é o comportamento esperado em volumes maiores — e é
    // exatamente o que derrubava a API antes.
    console.log(`   estourou: ${(e as Error).message}`)
    console.log('   → é este o modo de falha que o streaming elimina.')
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} verificação(ões) falharam.\n` : '\nTudo certo.\n')
process.exit(failures ? 1 : 0)
