// O JSONL de staging virando Parquet — os dois jeitos de isso falhar.
//
// Uma tabela de ERP com coluna de texto grande derrubou a ingestão inteira com
//   Invalid Input Error: "maximum_object_size" of 16777216 bytes exceeded
// e o erro engana duas vezes: não diz que o problema é UMA linha específica, e
// a mesma mensagem aparece quando o arquivo foi CORTADO no meio da escrita
// (disco cheio), que é um problema completamente diferente.
//
// Medido aqui, contra o DuckDB de verdade:
//   • linha BEM TERMINADA de 17 MB  → lê, mesmo com o teto padrão de 16 MB
//     (o DuckDB tem folga sobre o buffer);
//   • linha BEM TERMINADA de 40 MB  → falha com o teto padrão, lê com o teto
//     configurado. É o caso que justifica a variável;
//   • arquivo SEM a quebra de linha final → falha em qualquer tamanho, com a
//     MESMA mensagem. Causa completamente diferente: escrita interrompida.
//
// A última é a que aconteceu em produção (o erro reportou 17,7 MB, tamanho que
// uma linha terminada teria lido). Por isso o ingest confere a quebra de linha
// final ANTES de chamar o DuckDB: sem essa conferência, a suspeita recai sobre
// o tamanho de uma linha, e o problema é disco.
//
// Uso: npm run staging:smoke --workspace apps/api
import { writeFileSync, mkdtempSync, rmSync, createWriteStream, statSync, openSync, readSync, closeSync } from 'node:fs'
import { createGzip } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { duckQuery } from '../modules/query/duck.js'
import { config } from '../core/config.js'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const dir = mkdtempSync(join(tmpdir(), 'staging-smoke-')).replace(/\\/g, '/')
const NL = String.fromCharCode(10)
const PADRAO_DUCKDB = 16 * 1024 * 1024

// 40 MB: medido como o ponto em que uma linha BEM TERMINADA passa a falhar
// com o teto padrão. Em 17 MB o DuckDB ainda lê.
const grande = JSON.stringify({ id: 1, txt: 'y'.repeat(40 * 1024 * 1024) })
const folgada = JSON.stringify({ id: 9, txt: 'z'.repeat(17 * 1024 * 1024) })
const pequena = (i: number) => JSON.stringify({ id: i, txt: 'x'.repeat(100) })

const ler = async (arq: string, teto: number) => {
  const { rows } = await duckQuery(
    `select count(*) as n from read_json('${dir}/${arq}', columns={'id':'BIGINT','txt':'VARCHAR'}, ` +
    `format='newline_delimited', maximum_object_size=${teto})`,
  )
  return Number(rows[0].n)
}

try {
  console.log('\n── linha maior que o teto padrão do DuckDB ──')

  // 17 MB BEM TERMINADA: o DuckDB lê mesmo com o teto padrão de 16 MB — ele tem
  // folga sobre o buffer. Registrado para ninguém "consertar" o que não quebra
  // nesse tamanho, e porque é o tamanho que o erro de produção reportou.
  writeFileSync(join(dir, 'folgada.jsonl'), folgada + NL)
  const nf = await ler('folgada.jsonl', PADRAO_DUCKDB)
  check('linha de 17 MB bem terminada lê com o teto padrão', nf === 1, `leu ${nf}`)

  writeFileSync(join(dir, 'grande.jsonl'), pequena(1) + NL + grande + NL + pequena(2) + NL)
  try {
    await ler('grande.jsonl', PADRAO_DUCKDB)
    check('linha de 40 MB falha com o teto padrão', false, 'leu sem erro — o cenário mudou')
  } catch (e) {
    check('linha de 40 MB falha com o teto padrão',
      (e as Error).message.includes('maximum_object_size'), (e as Error).message.slice(0, 70))
  }

  // Com o teto configurado: lê as três linhas.
  const n = await ler('grande.jsonl', config.sync.maxJsonObjectBytes)
  check('com o teto configurado, lê todas as linhas', n === 3, `leu ${n} de 3`)
  check('o teto configurado é maior que o padrão do DuckDB',
    config.sync.maxJsonObjectBytes > PADRAO_DUCKDB,
    `${(config.sync.maxJsonObjectBytes / 1024 / 1024).toFixed(0)} MB`)

  console.log('\n── arquivo cortado no meio da escrita ──')
  // Mesmo erro, causa diferente: é por isso que a conferência da quebra de
  // linha final existe no ingest — para separar as duas antes do DuckDB opinar.
  writeFileSync(join(dir, 'truncado.jsonl'), pequena(1) + NL + folgada)
  try {
    await ler('truncado.jsonl', PADRAO_DUCKDB)
    check('arquivo truncado dá o mesmo erro, em tamanho que passaria', false, 'leu sem erro')
  } catch (e) {
    check('arquivo truncado dá o mesmo erro, em tamanho que passaria',
      (e as Error).message.includes('maximum_object_size'),
      'mesma mensagem, causa diferente — daí a conferência no ingest')
  }

  // ── Staging COMPRIMIDO ────────────────────────────────────────────────
  // O arquivo de staging vive do começo ao fim da carga e é ele, não o Parquet,
  // que faz o disco subir por horas. Comprimido, o pico cai por um fator grande.
  console.log('\n── staging comprimido ──')

  // Mesma sequência do ingest: escreve pelo gzip e espera o ARQUIVO fechar
  // (não o gzip — quem sabe que tudo chegou ao disco é o destino final).
  const escreverGz = async (arq: string, linhas: string[]) => {
    const arquivo = createWriteStream(join(dir, arq))
    const gz = createGzip({ level: 1 })
    gz.pipe(arquivo)
    let crus = 0
    for (const l of linhas) {
      const chunk = l + NL
      crus += Buffer.byteLength(chunk)
      await new Promise<void>((res, rej) => gz.write(chunk, (e) => (e ? rej(e) : res())))
    }
    await new Promise<void>((res, rej) => {
      arquivo.on('finish', () => res()); arquivo.on('error', rej); gz.end()
    })
    return crus
  }

  const linhas = Array.from({ length: 20_000 }, (_, i) => pequena(i))
  writeFileSync(join(dir, 'cru.jsonl'), linhas.map((l) => l + NL).join(''))
  const crusEsperados = await escreverGz('comp.jsonl.gz', linhas)

  const tamCru = statSync(join(dir, 'cru.jsonl')).size
  const tamGz = statSync(join(dir, 'comp.jsonl.gz')).size
  check('comprimir reduz o staging de forma relevante', tamGz * 4 < tamCru,
    `${(tamCru / 1024 / 1024).toFixed(1)} MB → ${(tamGz / 1024 / 1024).toFixed(1)} MB (${(tamCru / tamGz).toFixed(1)}x)`)

  // O DuckDB lê o .gz com a MESMA chamada — é o que torna a troca barata.
  const nGz = await ler('comp.jsonl.gz', config.sync.maxJsonObjectBytes)
  check('o DuckDB lê o staging comprimido sem mudar a chamada', nGz === linhas.length, `leu ${nGz}`)

  // A conferência de arquivo completo: o rodapé do gzip guarda o tamanho
  // DESCOMPRIMIDO, e é ele que denuncia uma escrita interrompida.
  const isize = (arq: string) => {
    const bytes = statSync(join(dir, arq)).size
    const fd = openSync(join(dir, arq), 'r')
    try {
      const b = Buffer.alloc(4)
      readSync(fd, b, 0, 4, bytes - 4)
      return b.readUInt32LE(0)
    } finally { closeSync(fd) }
  }
  check('o rodapé do gzip bate com o que foi escrito',
    isize('comp.jsonl.gz') === (crusEsperados >>> 0),
    `${isize('comp.jsonl.gz')} vs ${crusEsperados}`)

  // Arquivo cortado: o rodapé lido não bate mais — é assim que o ingest pega.
  const inteiro = statSync(join(dir, 'comp.jsonl.gz')).size
  const fd = openSync(join(dir, 'comp.jsonl.gz'), 'r')
  const buf = Buffer.alloc(inteiro)
  readSync(fd, buf, 0, inteiro, 0)
  closeSync(fd)
  writeFileSync(join(dir, 'cortado.jsonl.gz'), buf.subarray(0, inteiro - 200))
  check('arquivo cortado não bate com o que foi escrito',
    isize('cortado.jsonl.gz') !== (crusEsperados >>> 0))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${failures ? `${failures} verificação(ões) falharam.` : 'Tudo certo.'}`)
process.exit(failures ? 1 : 0)
