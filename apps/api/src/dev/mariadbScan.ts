// Varre o código à procura de consultas ao banco de METADADOS que o tradutor
// para MariaDB recusa (db.query / client.query com SQL literal). Trecho
// interpolado (${…}) vira um identificador neutro — então é uma aproximação:
// serve para achar o que portar, não prova que o resto está certo (isso é a
// suíte do comitê rodando com DATAHUB_TEST_DB_DRIVER=mariadb).
//   npx tsx src/dev/mariadbScan.ts
import ts from 'typescript'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { translate } from '../db/mariadb/translate.js'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// fontes externas (pools.ts, writeProducts) e o DuckDB não passam pelo tradutor
const SKIP = [/connectors[\\/]pools\.ts$/, /connectors[\\/]writeProducts\.ts$/, /connectors[\\/]introspect\.ts$/, /[\\/]dev[\\/]/, /[\\/]test[\\/]/, /scripts[\\/]rag\.ts$/, /db[\\/]mariadb[\\/]/]
const CALLERS = new Set(['db', 'client', 'c', 'tx', 'conn'])

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []
  })
}

let found = 0
let total = 0
for (const file of files(SRC)) {
  if (SKIP.some((r) => r.test(file))) continue
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true)
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'query'
      && ts.isIdentifier(n.expression.expression) && CALLERS.has(n.expression.expression.text) && n.arguments[0]) {
      const a = n.arguments[0]
      let sql: string | null = null
      if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) sql = a.text
      else if (ts.isTemplateExpression(a)) {
        // "$${n}" é um marcador montado em tempo de execução: vira $1
        let acc = a.head.text
        for (const s of a.templateSpans) { acc += (acc.endsWith('$') ? '1 ' : ' interp_x ') + s.literal.text }
        sql = acc
      }
      // ::vector só existe no ramo do Postgres (a busca do MariaDB é em memória)
      if (sql && !sql.includes('::vector')) {
        total++
        try {
          translate(sql, { pk: () => ['id'], notNull: () => false })
        } catch (e) {
          found++
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart())
          console.log(`${relative(SRC, file)}:${line + 1}  ${(e as Error).message.replace(/ Reescreva.*$/, '').replace('[mariadb] construção do Postgres sem tradução: ', '')}`)
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}
console.log(`\n${found} de ${total} consultas precisam de porte manual.`)
process.exit(found ? 1 : 0)
