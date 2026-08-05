// Leitura das métricas de modelo — compartilhado entre a listagem e o detalhe.
//
// Cada tipo de problema tem UMA métrica que responde "esse modelo presta?":
// AUC na classificação (independe do limiar e do desbalanceamento) e R² na
// regressão. As demais entram no detalhe, não na lista.
import type { MlMetrics, MlTask } from '@datahub/shared'

export type Verdict = 'ok' | 'warn' | 'crit' | 'neutral'

export interface Headline {
  label: string
  value: string
  verdict: Verdict
  hint: string
}

const pct = (v: number) => `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
const num = (v: number, d = 3) => v.toLocaleString('pt-BR', { maximumFractionDigits: d })

// Faixas de AUC usadas na prática: 0,5 é moeda ao alto; abaixo de 0,65 não
// serve para decidir nada; acima de 0,8 é utilizável no dia a dia.
export function aucVerdict(auc: number): Verdict {
  if (auc >= 0.8) return 'ok'
  if (auc >= 0.65) return 'warn'
  return 'crit'
}

export function r2Verdict(r2: number): Verdict {
  if (r2 >= 0.7) return 'ok'
  if (r2 >= 0.4) return 'warn'
  return 'crit'
}

export function headline(task: MlTask, m: MlMetrics | null | undefined): Headline {
  if (!m || (m.auc == null && m.r2 == null)) {
    return { label: '—', value: '—', verdict: 'neutral', hint: 'Ainda não treinado.' }
  }
  if (task === 'binary' && m.auc != null) {
    return {
      label: 'AUC',
      value: num(m.auc),
      verdict: aucVerdict(m.auc),
      hint: 'Chance de o modelo dar nota maior a um caso positivo do que a um negativo. 0,5 é sorteio.',
    }
  }
  return {
    label: 'R²',
    value: num(m.r2 ?? 0),
    verdict: r2Verdict(m.r2 ?? 0),
    hint: 'Fatia da variação do alvo que o modelo explica. 0 é prever sempre a média.',
  }
}

// Detalhamento por tipo de problema, já formatado para exibição.
export function metricRows(task: MlTask, m: MlMetrics): { label: string; value: string; hint: string }[] {
  if (task === 'binary') {
    const c = m.confusion
    return [
      { label: 'AUC', value: num(m.auc ?? 0), hint: 'Separação entre positivos e negativos, independente do limiar.' },
      { label: 'Acurácia', value: pct(m.accuracy ?? 0), hint: 'Acertos sobre o total. Engana quando as classes são desbalanceadas.' },
      { label: 'Precisão', value: pct(m.precision ?? 0), hint: 'Dos que o modelo apontou, quantos eram de fato.' },
      { label: 'Sensibilidade', value: pct(m.recall ?? 0), hint: 'Dos que eram de fato, quantos o modelo pegou.' },
      { label: 'F1', value: num(m.f1 ?? 0), hint: 'Equilíbrio entre precisão e sensibilidade.' },
      { label: 'Taxa de positivos', value: pct(m.positiveRate ?? 0), hint: 'Quanto da base de validação era positiva.' },
      ...(c ? [{
        label: 'Matriz de confusão',
        value: `${c.tp} VP · ${c.fp} FP · ${c.fn} FN · ${c.tn} VN`,
        hint: 'Contagem no limiar de 0,5.',
      }] : []),
    ]
  }
  return [
    { label: 'R²', value: num(m.r2 ?? 0), hint: 'Fatia da variação explicada.' },
    { label: 'RMSE', value: num(m.rmse ?? 0, 2), hint: 'Erro típico, na unidade do alvo. Pune erro grande.' },
    { label: 'MAE', value: num(m.mae ?? 0, 2), hint: 'Erro médio absoluto, na unidade do alvo.' },
    { label: 'Média do alvo', value: num(m.meanActual ?? 0, 2), hint: 'Referência para ler o RMSE.' },
  ]
}
