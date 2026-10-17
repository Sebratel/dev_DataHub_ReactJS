// Pasta temporária para os smokes que escrevem arquivo pelo DuckDB.
//
// O motor só alcança as pastas liberadas em duck.ts (engineAllowedDirs): o
// lake, o staging, a pasta do Databricks e o spill. Um smoke que escreve em
// os.tmpdir() recebe "Permission Error" — que é justamente a proteção do
// SEG-01 funcionando. Então o smoke vai para DENTRO do lake, numa pasta com
// ponto na frente: a faxina do boot (faxinaLake) e o catálogo ignoram nomes
// que começam com ".", e cada smoke apaga a sua no fim.
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { LAKE_ROOT } from '../core/lake.js'

export function smokeDir(prefix: string): string {
  const base = join(LAKE_ROOT, '.smoke')
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, prefix))
}
