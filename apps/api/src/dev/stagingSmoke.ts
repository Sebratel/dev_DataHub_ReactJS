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
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
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

  // A conferência do ingest: último byte do arquivo tem de ser quebra de linha.
  const terminaBem = (s: string) => s.charCodeAt(s.length - 1) === 10
  check('a conferência distingue arquivo completo de truncado',
    terminaBem(pequena(1) + NL + folgada + NL) && !terminaBem(pequena(1) + NL + folgada))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${failures ? `${failures} verificação(ões) falharam.` : 'Tudo certo.'}`)
process.exit(failures ? 1 : 0)
