// ─────────────────────────────────────────────────────────────────────────
// Orquestração do treino: lê a definição, monta a matriz, roda o motor e grava
// uma VERSÃO imutável.
//
// Fila de UM por vez, igual à da ingestão. Treino é CPU concentrada no mesmo
// container do motor de consulta; dois em paralelo transformariam uma tela
// lenta em uma tela parada.
// ─────────────────────────────────────────────────────────────────────────
import { Worker } from 'node:worker_threads'
import { db } from '../../db/pool.js'
import { runFeatureSql, buildSchema, encodeMatrix, type FeatureSchema } from './features.js'
import { runTraining, type TrainingInput, type TrainingResult, type Task, type Algorithm } from './trainer.js'

export interface ModelRow {
  id: string
  slug: string
  tenantSlug: string
  task: Task
  algorithm: string
  featureSql: string | null
  targetColumn: string | null
  excludedColumns: string[]
  holdoutPct: number
  maxRows: number
  hyperparams: Record<string, unknown>
}

// ── Fila sequencial ──────────────────────────────────────────────────────
let chain: Promise<unknown> = Promise.resolve()
let queued = 0

export function queueDepth(): number { return queued }

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  queued++
  const next = chain.then(job, job).finally(() => { queued-- })
  chain = next.catch(() => { /* um treino que falha não trava a fila */ })
  return next
}

// ── Motor: worker quando dá, em processo quando não dá ───────────────────
// O worker é o caminho desejado. Sob `tsx` a criação pode falhar se o loader
// não propagar para a thread — nesse caso o treino roda em processo e o motivo
// vai para o log, em vez de a funcionalidade simplesmente não existir.
let workerBroken = false

function trainInWorker(input: TrainingInput): Promise<TrainingResult> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), {
        // Propaga o loader do tsx para a thread (a API roda sem build step).
        execArgv: ['--import', 'tsx'],
      })
    } catch (e) {
      return reject(e)
    }
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      void worker.terminate()
      fn()
    }
    worker.on('message', (m: { ok: boolean; result?: TrainingResult; error?: string }) => {
      done(() => (m.ok && m.result ? resolve(m.result) : reject(new Error(m.error ?? 'falha no worker'))))
    })
    worker.on('error', (e) => done(() => reject(e)))
    worker.on('exit', (code) => {
      if (!settled) done(() => reject(new Error(`worker de treino encerrou com código ${code}`)))
    })
    // A matriz é TRANSFERIDA, não copiada: evita dobrar o pico de memória num
    // buffer que pode passar de 100 MB. Depois disto os arrays ficam vazios
    // deste lado — `input` não pode mais ser usado aqui.
    worker.postMessage(input, [input.x.buffer as ArrayBuffer, input.y.buffer as ArrayBuffer])
  })
}

async function train(input: TrainingInput): Promise<TrainingResult> {
  if (!workerBroken) {
    try {
      return await trainInWorker(input)
    } catch (e) {
      workerBroken = true
      console.warn(
        `[ml] worker de treino indisponível (${(e as Error).message}) — treinando em processo. ` +
        'A API fica menos responsiva durante o treino.',
      )
    }
  }
  return runTraining(input)
}

// ── Treino de um modelo ──────────────────────────────────────────────────
export interface TrainOutcome {
  runId: string
  versionId: string
  version: number
  metrics: Record<string, unknown>
  rowsTrained: number
  rowsHoldout: number
  dropped: FeatureSchema['dropped']
  skippedRows: number
}

export function trainModel(
  model: ModelRow, byEmail: string, trigger: 'manual' | 'schedule' = 'manual',
): Promise<TrainOutcome> {
  return enqueue(async () => {
    const run = (await db.query(
      `insert into ml_training_runs (model_id, trigger) values ($1, $2) returning id`,
      [model.id, trigger],
    )).rows[0]
    const runId = String(run.id)

    try {
      if (model.algorithm !== 'logistic' && model.algorithm !== 'linear') {
        throw new Error(`Algoritmo "${model.algorithm}" ainda não é treinado no hub. Use logistic ou linear, ou importe um modelo ONNX.`)
      }
      if (!model.featureSql?.trim()) throw new Error('Modelo sem SQL de atributos.')
      if (!model.targetColumn?.trim()) throw new Error('Modelo sem coluna alvo definida.')

      const rows = await runFeatureSql(model.tenantSlug, model.featureSql, model.maxRows)
      const schema = buildSchema(rows, model.targetColumn, model.task, model.excludedColumns)
      const { matrix, skipped } = encodeMatrix(rows, schema)

      const result = await train({
        task: model.task,
        algorithm: model.algorithm as Algorithm,
        // encodeMatrix devolve SUBARRAY (vista sobre um buffer maior, porque as
        // linhas sem alvo válido foram descartadas). Transferir transfere o
        // buffer inteiro, então copiamos para um do tamanho exato — é a única
        // cópia da matriz em todo o caminho.
        x: new Float64Array(matrix.x),
        y: new Float64Array(matrix.y),
        rows: matrix.rows,
        cols: matrix.cols,
        featureNames: schema.features.map((f) => f.name),
        holdoutPct: model.holdoutPct,
        hyperparams: model.hyperparams,
      })

      const nextVersion = Number((await db.query(
        `select coalesce(max(version), 0) + 1 as v from ml_model_versions where model_id = $1`,
        [model.id],
      )).rows[0].v)

      const version = (await db.query(
        `insert into ml_model_versions
           (model_id, version, artifact, feature_schema, metrics, importances,
            rows_trained, rows_holdout, trained_ms, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [
          model.id, nextVersion,
          JSON.stringify(result.artifact), JSON.stringify(schema),
          JSON.stringify(result.metrics), JSON.stringify(result.importances.slice(0, 40)),
          result.rowsTrained, result.rowsHoldout, result.trainedMs, byEmail,
        ],
      )).rows[0]

      await db.query(
        `update ml_training_runs set status = 'done', version_id = $2, rows = $3, finished_at = now() where id = $1`,
        [runId, version.id, result.rowsTrained + result.rowsHoldout],
      )
      // Primeira versão entra promovida: um modelo treinado e não promovido não
      // serve para nada, e promover à mão só faz sentido a partir da segunda.
      await db.query(
        `update ml_models set promoted_version_id = coalesce(promoted_version_id, $2), updated_at = now() where id = $1`,
        [model.id, version.id],
      )

      console.log(`[ml] ${model.slug} v${nextVersion}: ${result.rowsTrained} treino / ${result.rowsHoldout} validação em ${result.trainedMs}ms.`)
      return {
        runId,
        versionId: String(version.id),
        version: nextVersion,
        metrics: result.metrics,
        rowsTrained: result.rowsTrained,
        rowsHoldout: result.rowsHoldout,
        dropped: schema.dropped,
        skippedRows: skipped,
      }
    } catch (e) {
      await db.query(
        `update ml_training_runs set status = 'error', error = $2, finished_at = now() where id = $1`,
        [runId, (e as Error).message],
      )
      throw e
    }
  })
}
