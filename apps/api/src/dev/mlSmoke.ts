// Fumaça do motor de ML — `npx tsx apps/api/src/dev/mlSmoke.ts`.
//
// Não precisa de banco nem de lake: gera dados sintéticos com resposta
// CONHECIDA e confere se o motor a recupera. Código numérico erra em silêncio
// (devolve um número plausível), então este é o único jeito de saber que a
// conta está certa sem esperar um modelo ruim chegar em produção.
import { runTraining } from '../modules/ml/trainer.js'
import { buildSchema, encodeMatrix } from '../modules/ml/features.js'

let seed = 7
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }

// ── 1. Classificação binária ─────────────────────────────────────────────
// Cancelamento depende de tempo de casa, chamados e plano — mais ruído, para
// não ser separável de forma trivial.
const binRows: Record<string, unknown>[] = []
for (let i = 0; i < 4000; i++) {
  const meses = Math.floor(rnd() * 60)
  const chamados = Math.floor(rnd() * 8)
  const plano = ['basico', 'pro', 'premium'][Math.floor(rnd() * 3)]
  const z = -2.2 + 0.27 * chamados - 0.05 * meses
    + (plano === 'basico' ? 1.4 : plano === 'pro' ? 0.2 : -0.9)
  const p = 1 / (1 + Math.exp(-z))
  binRows.push({
    cliente_id: `c${i}`,        // identificador: TEM de ser descartado
    meses_casa: meses,
    chamados_90d: chamados,
    plano,                       // categórica: vira one-hot
    cancelou: rnd() < p ? 1 : 0,
  })
}

const binSchema = buildSchema(binRows, 'cancelou', 'binary', [])
const binEnc = encodeMatrix(binRows, binSchema)
const bin = runTraining({
  task: 'binary', algorithm: 'logistic',
  x: new Float64Array(binEnc.matrix.x), y: new Float64Array(binEnc.matrix.y),
  rows: binEnc.matrix.rows, cols: binEnc.matrix.cols,
  featureNames: binSchema.features.map((f) => f.name),
  holdoutPct: 25, hyperparams: {},
})

console.log('── binária ──')
console.log('descartadas :', binSchema.dropped.map((d) => `${d.column} (${d.reason})`).join(' | ') || 'nenhuma')
console.log('atributos   :', binSchema.features.map((f) => f.name).join(', '))
console.log('treino/valid:', bin.rowsTrained, '/', bin.rowsHoldout, `em ${bin.trainedMs}ms`)
console.log('métricas    :', JSON.stringify(bin.metrics))
console.log('top pesos   :', bin.importances.slice(0, 4).map((i) => `${i.feature}=${i.weight.toFixed(3)}`).join(', '))

// ── 2. Regressão ─────────────────────────────────────────────────────────
// receita = 50 + 3,5·consumo − 12·quedas + ruído. Os pesos saem em escala
// padronizada, então o que se confere é sinal e ordem de grandeza.
const regRows: Record<string, unknown>[] = []
for (let i = 0; i < 3000; i++) {
  const consumo = rnd() * 200
  const quedas = Math.floor(rnd() * 10)
  regRows.push({
    consumo_gb: consumo,
    quedas_mes: quedas,
    receita: 50 + 3.5 * consumo - 12 * quedas + (rnd() - 0.5) * 20,
  })
}
const regSchema = buildSchema(regRows, 'receita', 'regression', [])
const regEnc = encodeMatrix(regRows, regSchema)
const reg = runTraining({
  task: 'regression', algorithm: 'linear',
  x: new Float64Array(regEnc.matrix.x), y: new Float64Array(regEnc.matrix.y),
  rows: regEnc.matrix.rows, cols: regEnc.matrix.cols,
  featureNames: regSchema.features.map((f) => f.name),
  holdoutPct: 25, hyperparams: {},
})
console.log('\n── regressão ──')
console.log('métricas    :', JSON.stringify(reg.metrics))
console.log('pesos       :', reg.importances.map((i) => `${i.feature}=${i.weight.toFixed(2)}`).join(', '))

// ── Veredito ─────────────────────────────────────────────────────────────
const m = bin.metrics as { auc: number; accuracy: number }
const r = reg.metrics as { r2: number }
const w = (f: string) => reg.importances.find((i) => i.feature === f)?.weight ?? 0

const checks: [string, boolean][] = [
  ['AUC binária > 0,72', m.auc > 0.72],
  ['acurácia binária > 0,65', m.accuracy > 0.65],
  ['identificador descartado', binSchema.dropped.some((d) => d.column === 'cliente_id')],
  ['plano virou one-hot', binSchema.features.some((f) => f.kind === 'onehot')],
  ['R² da regressão > 0,98', r.r2 > 0.98],
  ['peso de consumo positivo', w('consumo_gb') > 0],
  ['peso de quedas negativo', w('quedas_mes') < 0],
]

console.log('\n── veredito ──')
let ok = true
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASSA' : 'FALHA'}  ${label}`)
  if (!pass) ok = false
}
process.exit(ok ? 0 : 1)
