// ─────────────────────────────────────────────────────────────────────────
// Núcleo matemático dos modelos. Implementado aqui em vez de trazer uma
// biblioteca: são duas famílias bem definidas, o controle de memória importa
// (a matriz mora no mesmo container do motor de consulta) e assim não há
// dependência nativa nova na imagem.
//
// Tudo opera sobre Float64Array achatado (linha-maior): 200k × 60 atributos
// são ~96 MB de matriz contígua, contra alguns GB se fosse array de objetos.
// ─────────────────────────────────────────────────────────────────────────

export interface Matrix {
  /** Valores achatados, linha-maior: x[i * cols + j]. */
  x: Float64Array
  y: Float64Array
  rows: number
  cols: number
}

// ── Padronização (z-score) ───────────────────────────────────────────────
// Obrigatória para a descida de gradiente convergir: sem ela um atributo em
// reais (10^4) domina outro em fração (10^-1) e o passo útil vira ruído.
// Média e desvio VÃO NO ARTEFATO — a predição precisa aplicar exatamente a
// mesma transformação, senão o modelo responde número plausível e errado.
export interface Scaler { mean: number[]; std: number[] }

export function fitScaler(m: Matrix): Scaler {
  const mean = new Array<number>(m.cols).fill(0)
  const std = new Array<number>(m.cols).fill(0)
  for (let j = 0; j < m.cols; j++) {
    let s = 0
    for (let i = 0; i < m.rows; i++) s += m.x[i * m.cols + j]
    mean[j] = s / m.rows
  }
  for (let j = 0; j < m.cols; j++) {
    let s = 0
    for (let i = 0; i < m.rows; i++) {
      const d = m.x[i * m.cols + j] - mean[j]
      s += d * d
    }
    // Coluna constante: desvio 0 zeraria por divisão. Vira 1 → a coluna some
    // do gradiente sem quebrar a conta.
    std[j] = Math.sqrt(s / m.rows) || 1
  }
  return { mean, std }
}

export function applyScaler(m: Matrix, s: Scaler): void {
  for (let i = 0; i < m.rows; i++) {
    const base = i * m.cols
    for (let j = 0; j < m.cols; j++) {
      m.x[base + j] = (m.x[base + j] - s.mean[j]) / s.std[j]
    }
  }
}

export function scaleRow(row: number[], s: Scaler): number[] {
  return row.map((v, j) => (v - s.mean[j]) / s.std[j])
}

// ── Divisão treino / validação ───────────────────────────────────────────
// Embaralhamento determinístico (semente fixa): dois treinos do mesmo conjunto
// dão a mesma divisão, então uma diferença de métrica entre versões vem do
// modelo, não do sorteio.
function seededShuffle(n: number, seed = 42): Int32Array {
  const idx = new Int32Array(n)
  for (let i = 0; i < n; i++) idx[i] = i
  let s = seed
  for (let i = n - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0 // LCG (Numerical Recipes)
    const j = s % (i + 1)
    const t = idx[i]; idx[i] = idx[j]; idx[j] = t
  }
  return idx
}

export function splitHoldout(m: Matrix, pct: number): { train: Matrix; test: Matrix } {
  const order = seededShuffle(m.rows)
  const nTest = Math.max(1, Math.floor((m.rows * pct) / 100))
  const nTrain = m.rows - nTest
  const mk = (count: number, from: number): Matrix => {
    const x = new Float64Array(count * m.cols)
    const y = new Float64Array(count)
    for (let k = 0; k < count; k++) {
      const src = order[from + k] * m.cols
      x.set(m.x.subarray(src, src + m.cols), k * m.cols)
      y[k] = m.y[order[from + k]]
    }
    return { x, y, rows: count, cols: m.cols }
  }
  return { train: mk(nTrain, 0), test: mk(nTest, nTrain) }
}

// ── Regressão logística (classificação binária) ──────────────────────────
export interface LinearModel { weights: number[]; bias: number; scaler: Scaler }

const sigmoid = (z: number) => (z >= 0
  // Duas formas algebricamente idênticas; cada uma evita o overflow de exp()
  // no seu lado do domínio. Sem isso, z muito negativo vira Infinity → NaN.
  ? 1 / (1 + Math.exp(-z))
  : Math.exp(z) / (1 + Math.exp(z)))

export interface FitOptions {
  learningRate?: number
  iterations?: number
  /** Regularização L2: segura os pesos quando há atributos correlacionados. */
  l2?: number
  /** Para se a melhora da perda ficar abaixo disto. */
  tolerance?: number
}

export function fitLogistic(m: Matrix, opts: FitOptions = {}): LinearModel {
  const lr = opts.learningRate ?? 0.3
  const maxIter = opts.iterations ?? 600
  const l2 = opts.l2 ?? 1e-4
  const tol = opts.tolerance ?? 1e-7

  const scaler = fitScaler(m)
  applyScaler(m, scaler)

  const w = new Float64Array(m.cols)
  let b = 0
  const gw = new Float64Array(m.cols)
  let prevLoss = Infinity

  for (let it = 0; it < maxIter; it++) {
    gw.fill(0)
    let gb = 0
    let loss = 0

    for (let i = 0; i < m.rows; i++) {
      const base = i * m.cols
      let z = b
      for (let j = 0; j < m.cols; j++) z += w[j] * m.x[base + j]
      const p = sigmoid(z)
      const err = p - m.y[i]
      for (let j = 0; j < m.cols; j++) gw[j] += err * m.x[base + j]
      gb += err
      // Perda logarítmica, com piso para não estourar em log(0).
      const eps = 1e-12
      loss -= m.y[i] * Math.log(Math.max(p, eps)) + (1 - m.y[i]) * Math.log(Math.max(1 - p, eps))
    }

    loss /= m.rows
    for (let j = 0; j < m.cols; j++) {
      w[j] -= lr * (gw[j] / m.rows + l2 * w[j])
    }
    b -= lr * (gb / m.rows)

    if (Math.abs(prevLoss - loss) < tol) break
    prevLoss = loss
  }

  return { weights: Array.from(w), bias: b, scaler }
}

export function predictLogistic(model: LinearModel, rawRow: number[]): number {
  const r = scaleRow(rawRow, model.scaler)
  let z = model.bias
  for (let j = 0; j < r.length; j++) z += model.weights[j] * r[j]
  return sigmoid(z)
}

// ── Regressão linear (alvo contínuo) ─────────────────────────────────────
// Equações normais com ridge: (XᵀX + λI)w = Xᵀy. Direto e exato para o número
// de atributos que cabe aqui (dezenas), sem iteração nem taxa de aprendizado.
export function fitLinear(m: Matrix, opts: FitOptions = {}): LinearModel {
  const l2 = opts.l2 ?? 1e-6
  const scaler = fitScaler(m)
  applyScaler(m, scaler)

  const n = m.cols
  // Matriz aumentada [XᵀX + λI | Xᵀy], resolvida por Gauss-Jordan.
  const a: number[][] = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0))
  let meanY = 0
  for (let i = 0; i < m.rows; i++) meanY += m.y[i]
  meanY /= m.rows

  for (let i = 0; i < m.rows; i++) {
    const base = i * m.cols
    const dy = m.y[i] - meanY
    for (let j = 0; j < n; j++) {
      const xj = m.x[base + j]
      for (let k = j; k < n; k++) a[j][k] += xj * m.x[base + k]
      a[j][n] += xj * dy
    }
  }
  // XᵀX é simétrica — só a metade superior foi somada; espelha e aplica ridge.
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < j; k++) a[j][k] = a[k][j]
    a[j][j] += l2 * m.rows
  }

  // Eliminação com pivotamento parcial (estabilidade numérica).
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r
    if (Math.abs(a[pivot][col]) < 1e-12) continue // coluna degenerada → peso 0
    if (pivot !== col) { const t = a[pivot]; a[pivot] = a[col]; a[col] = t }
    const d = a[col][col]
    for (let k = col; k <= n; k++) a[col][k] /= d
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = a[r][col]
      if (!f) continue
      for (let k = col; k <= n; k++) a[r][k] -= f * a[col][k]
    }
  }

  const weights = Array.from({ length: n }, (_, j) => a[j][n] || 0)
  return { weights, bias: meanY, scaler }
}

export function predictLinear(model: LinearModel, rawRow: number[]): number {
  const r = scaleRow(rawRow, model.scaler)
  let z = model.bias
  for (let j = 0; j < r.length; j++) z += model.weights[j] * r[j]
  return z
}

// ── Métricas ─────────────────────────────────────────────────────────────
export interface BinaryMetrics {
  auc: number
  accuracy: number
  precision: number
  recall: number
  f1: number
  confusion: { tp: number; fp: number; tn: number; fn: number }
  positiveRate: number
}

// AUC por soma de postos (Mann-Whitney U) — O(n log n) e sem varrer limiares.
// Empates recebem posto médio, senão o valor infla com scores repetidos.
export function auc(scores: number[], labels: number[]): number {
  const n = scores.length
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[a] - scores[b])
  const ranks = new Float64Array(n)
  let i = 0
  while (i < n) {
    let j = i
    while (j + 1 < n && scores[order[j + 1]] === scores[order[i]]) j++
    const avg = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) ranks[order[k]] = avg
    i = j + 1
  }
  let pos = 0
  let sumRankPos = 0
  for (let k = 0; k < n; k++) {
    if (labels[k] === 1) { pos++; sumRankPos += ranks[k] }
  }
  const neg = n - pos
  if (!pos || !neg) return 0.5 // uma classe só: AUC indefinida
  return (sumRankPos - (pos * (pos + 1)) / 2) / (pos * neg)
}

export function binaryMetrics(scores: number[], labels: number[], threshold = 0.5): BinaryMetrics {
  let tp = 0, fp = 0, tn = 0, fn = 0
  for (let i = 0; i < scores.length; i++) {
    const pred = scores[i] >= threshold ? 1 : 0
    if (pred === 1 && labels[i] === 1) tp++
    else if (pred === 1) fp++
    else if (labels[i] === 1) fn++
    else tn++
  }
  const precision = tp + fp ? tp / (tp + fp) : 0
  const recall = tp + fn ? tp / (tp + fn) : 0
  return {
    auc: auc(scores, labels),
    accuracy: (tp + tn) / scores.length,
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    confusion: { tp, fp, tn, fn },
    positiveRate: (tp + fn) / scores.length,
  }
}

export interface RegressionMetrics { rmse: number; mae: number; r2: number; meanActual: number }

export function regressionMetrics(preds: number[], actual: number[]): RegressionMetrics {
  const n = preds.length
  let se = 0, ae = 0, mean = 0
  for (let i = 0; i < n; i++) mean += actual[i]
  mean /= n
  let tss = 0
  for (let i = 0; i < n; i++) {
    const d = preds[i] - actual[i]
    se += d * d
    ae += Math.abs(d)
    tss += (actual[i] - mean) ** 2
  }
  return {
    rmse: Math.sqrt(se / n),
    mae: ae / n,
    r2: tss ? 1 - se / tss : 0,
    meanActual: mean,
  }
}

// Importância dos atributos. Com os dados padronizados, o |peso| já é
// comparável entre colunas — é a leitura honesta para um modelo linear.
export function linearImportances(model: LinearModel, names: string[]): { feature: string; weight: number; abs: number }[] {
  return names
    .map((feature, j) => ({ feature, weight: model.weights[j] ?? 0, abs: Math.abs(model.weights[j] ?? 0) }))
    .sort((a, b) => b.abs - a.abs)
}
