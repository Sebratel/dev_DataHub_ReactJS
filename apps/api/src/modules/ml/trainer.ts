// Trabalho puro de CPU do treino: matriz entra, artefato e métricas saem.
// Sem banco, sem rede, sem estado — é o que permite rodar esta mesma função
// dentro de um worker_thread OU em processo, sem duas implementações.
import {
  fitLogistic, fitLinear, predictLogistic, predictLinear,
  splitHoldout, binaryMetrics, regressionMetrics, linearImportances,
  type Matrix, type LinearModel, type FitOptions,
} from './algorithms.js'

export type Task = 'binary' | 'regression'
export type Algorithm = 'logistic' | 'linear'

export interface TrainingInput {
  task: Task
  algorithm: Algorithm
  /** Matriz achatada — atravessa a fronteira do worker como Transferable. */
  x: Float64Array
  y: Float64Array
  rows: number
  cols: number
  featureNames: string[]
  holdoutPct: number
  hyperparams: FitOptions
}

export interface TrainingResult {
  artifact: { kind: Algorithm; model: LinearModel }
  metrics: Record<string, unknown>
  importances: { feature: string; weight: number; abs: number }[]
  rowsTrained: number
  rowsHoldout: number
  trainedMs: number
}

export function runTraining(input: TrainingInput): TrainingResult {
  const started = Date.now()
  const full: Matrix = { x: input.x, y: input.y, rows: input.rows, cols: input.cols }

  // Validação separada ANTES do ajuste: uma métrica calculada sobre os dados de
  // treino sempre parece ótima e não diz nada sobre o mundo real.
  const { train, test } = splitHoldout(full, input.holdoutPct)

  // fitLogistic/fitLinear padronizam a matriz NO LUGAR; a validação precisa
  // continuar crua, porque o predict aplica o scaler guardado no artefato.
  const model = input.algorithm === 'logistic'
    ? fitLogistic(train, input.hyperparams)
    : fitLinear(train, input.hyperparams)

  const predict = input.algorithm === 'logistic' ? predictLogistic : predictLinear
  const preds: number[] = new Array(test.rows)
  const actual: number[] = new Array(test.rows)
  const row = new Array<number>(test.cols)
  for (let i = 0; i < test.rows; i++) {
    const base = i * test.cols
    for (let j = 0; j < test.cols; j++) row[j] = test.x[base + j]
    preds[i] = predict(model, row)
    actual[i] = test.y[i]
  }

  const metrics = input.task === 'binary'
    ? binaryMetrics(preds, actual) as unknown as Record<string, unknown>
    : regressionMetrics(preds, actual) as unknown as Record<string, unknown>

  return {
    artifact: { kind: input.algorithm, model },
    metrics,
    importances: linearImportances(model, input.featureNames),
    rowsTrained: train.rows,
    rowsHoldout: test.rows,
    trainedMs: Date.now() - started,
  }
}
