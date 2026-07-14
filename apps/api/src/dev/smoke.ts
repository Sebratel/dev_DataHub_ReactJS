// Smoke test dos conectores (npm run smoke): ping barato (SELECT 1) em cada
// fonte configurada e descoberta de tabelas via information_schema na ELLEVEN.
// Não toca dado de negócio — seguro rodar a qualquer hora.
import '../core/config.js' // carrega o .env da raiz
import { CONNECTORS, isConfigured } from '../connectors/registry.js'
import { checkConnection, discoverObjects } from '../connectors/pools.js'

for (const def of CONNECTORS) {
  if (!isConfigured(def)) {
    console.log(`${def.id.padEnd(8)} SEM CREDENCIAIS no .env (${def.envPrefix}_*)`)
    continue
  }
  const r = await checkConnection(def.id)
  console.log(`${def.id.padEnd(8)} ${r.ok ? 'OK  ' : 'ERRO'} ${String(r.latencyMs).padStart(5)} ms${r.error ? ' — ' + r.error : ''}`)
}

const objects = await discoverObjects('elleven')
console.log(`\nelleven: ${objects.length} tabelas/views descobertas`)
console.log(`ex.: ${objects.slice(0, 6).map((o) => o.name).join(', ')}`)
process.exit(0)
