// Smoke da integridade das partes do lake. Usa Parquet DE VERDADE, escrito
// pelo DuckDB, porque a coisa toda gira em torno de bytes num arquivo.
//
// O defeito que motivou isto: o `COPY ... TO` escrevia direto com o nome final
// dentro da pasta do conjunto. Interrompido no meio, deixava um
// "part-xxx.parquet" truncado — e `read_parquet(pasta/*.parquet)` lê TODOS os
// arquivos, então aquele um derrubava a leitura do conjunto inteiro, de todo
// calculado que o referenciava e de todo painel que o usava. Para sempre, até
// alguém apagar à mão. Aconteceu em produção, e a mensagem do DuckDB ("too
// small to be a Parquet file") não diz nem qual conjunto nem o que fazer.
//
// Uso: npm run lake:smoke --workspace apps/api
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { duckQuery } from '../modules/query/duck.js'
import {
  parquetIntacto, faxinaDataset, partEmEscrita, concluiParte, descartaParte,
  listParquet, parquetGlob, SUFIXO_EM_ESCRITA,
} from '../core/lake.js'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const dir = mkdtempSync(join(tmpdir(), 'lake-repair-')).replace(/\\/g, '/')

// ── Um Parquet legítimo, escrito pelo DuckDB ─────────────────────────────
const bom = join(dir, 'part-bom.parquet').replace(/\\/g, '/')
await duckQuery(`copy (select 1 as a, 'x' as b union all select 2, 'y') to '${bom}' (format parquet)`)

console.log('\n── reconhecer um Parquet íntegro ──')
check('arquivo escrito pelo DuckDB é íntegro', parquetIntacto(bom))
check('e é legível', Number((await duckQuery(`select count(*) n from read_parquet('${bom}')`)).rows[0]?.n) === 2)

// ── As formas de ficar pela metade ───────────────────────────────────────
console.log('\n── reconhecer o que está corrompido ──')
const bytes = readFileSync(bom)
const truncado = join(dir, 'part-truncado.parquet')
writeFileSync(truncado, bytes.subarray(0, Math.floor(bytes.length / 2)))
check('cortado na metade não passa', !parquetIntacto(truncado), `${statSync(truncado).size} bytes`)

const vazio = join(dir, 'part-vazio.parquet')
writeFileSync(vazio, '')
check('arquivo de 0 byte não passa', !parquetIntacto(vazio))

// O caso mais traiçoeiro: tem o cabeçalho, não tem o rodapé. Começa com PAR1
// e parece um Parquet para qualquer checagem ingênua de "primeiros bytes".
const semRodape = join(dir, 'part-sem-rodape.parquet')
writeFileSync(semRodape, Buffer.concat([Buffer.from('PAR1'), Buffer.alloc(64, 7)]))
check('com cabeçalho e sem rodapé não passa', !parquetIntacto(semRodape))
check('inexistente não passa', !parquetIntacto(join(dir, 'nao-existe.parquet')))

// ── É mesmo isto que derruba a leitura? ──────────────────────────────────
console.log('\n── um arquivo ruim derruba a pasta inteira ──')
let derrubou = false
try {
  await duckQuery(`select count(*) n from read_parquet('${parquetGlob(dir)}')`)
} catch (e) {
  derrubou = true
  check('a leitura da pasta falha com o arquivo ruim dentro', true,
    (e as Error).message.split('\n')[0].slice(0, 80))
}
if (!derrubou) check('a leitura da pasta falha com o arquivo ruim dentro', false, 'leu sem reclamar')

// ── A faxina devolve a pasta legível ─────────────────────────────────────
console.log('\n── faxina ──')
const emEscrita = join(dir, `part-interrompida.parquet${SUFIXO_EM_ESCRITA}`)
writeFileSync(emEscrita, bytes.subarray(0, 20))
check('a parte em escrita não entra no glob', !listParquet(dir).includes(emEscrita))

const r = faxinaDataset(dir)
check('removeu a parte em escrita', r.parciais.length === 1 && !existsSync(emEscrita))
check('pôs os 3 corrompidos em quarentena', r.emQuarentena.length === 3, r.emQuarentena.length.toString())
check('não apagou: renomeou para .corrompido',
  readdirSync(dir).filter((f) => f.endsWith('.corrompido')).length === 3)
check('o Parquet bom ficou intocado', existsSync(bom) && listParquet(dir).length === 1)

const n = Number((await duckQuery(`select count(*) n from read_parquet('${parquetGlob(dir)}')`)).rows[0]?.n)
check('a pasta voltou a ser legível, com o dado bom', n === 2, `${n} linha(s)`)

// ── O ciclo de escrita: concluir e descartar ─────────────────────────────
console.log('\n── escrita atômica ──')
const p1 = partEmEscrita(dir, 'run-ok')
await duckQuery(`copy (select 9 as a, 'z' as b) to '${p1.tmp.replace(/\\/g, '/')}' (format parquet)`)
check('durante a escrita o arquivo não está no glob', !listParquet(dir).includes(p1.final))
concluiParte(p1)
check('depois de concluir, está', listParquet(dir).includes(p1.final) && parquetIntacto(p1.final))

const p2 = partEmEscrita(dir, 'run-falho')
writeFileSync(p2.tmp, bytes.subarray(0, 30)) // COPY que morreu no meio
descartaParte(p2)
check('descartar remove o resto da escrita falha', !existsSync(p2.tmp) && !existsSync(p2.final))
check('e a pasta segue legível',
  Number((await duckQuery(`select count(*) n from read_parquet('${parquetGlob(dir)}')`)).rows[0]?.n) === 3)

rmSync(dir, { recursive: true, force: true })
console.log(`\n${failures ? `${failures} FALHA(S)` : 'tudo ok'}\n`)
process.exit(failures ? 1 : 0)
