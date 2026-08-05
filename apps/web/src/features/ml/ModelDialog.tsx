// Definição de um modelo: SQL de atributos, coluna alvo e tipo de problema.
//
// A peça central é a PRÉVIA. Sem ela a pessoa descobre depois de dois minutos
// de treino que metade das colunas era identificador — ou pior, que o alvo
// vazou para dentro dos atributos e o modelo "acertou" 99%. A prévia mostra o
// que virou atributo e o que foi descartado, com o motivo, antes de treinar.
import { useEffect, useState } from 'react'
import { Brain, X, Check, Loader2, Eye, AlertTriangle, Ban } from 'lucide-react'
import type { MlModel, MlTask, MlFeaturePreview } from '@datahub/shared'
import { api, ApiError } from '@/lib/api'

const INPUT = 'w-full rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-[12px] transition-colors '
  + 'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15 '
  + 'dark:border-zinc-800 dark:bg-zinc-950'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[9.5px] font-semibold uppercase tracking-[0.09em] text-zinc-500">{label}</span>
      {children}
      {hint && <span className="text-[10.5px] leading-snug text-zinc-400">{hint}</span>}
    </label>
  )
}

const EXAMPLE = `select
  c.cliente_id,
  c.meses_casa,
  c.plano,
  coalesce(ch.chamados_90d, 0) as chamados_90d,
  c.cancelou
from cliente_estado_atual c
left join atendimento_sla ch on ch.cliente_id = c.cliente_id`

export default function ModelDialog({ initial, onClose, onSaved }: {
  initial: MlModel | null
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = !!initial
  const [slug, setSlug] = useState(initial?.slug ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [task, setTask] = useState<MlTask>(initial?.task ?? 'binary')
  const [featureSql, setFeatureSql] = useState(initial?.feature_sql ?? '')
  const [targetColumn, setTargetColumn] = useState(initial?.target_column ?? '')
  const [excluded, setExcluded] = useState<string[]>(initial?.excluded_columns ?? [])
  const [holdoutPct, setHoldoutPct] = useState(String(initial?.holdout_pct ?? 20))
  const [maxRows, setMaxRows] = useState(String(initial?.max_rows ?? 200_000))
  const [retrain, setRetrain] = useState(initial?.retrain ?? 'manual')

  const [preview, setPreview] = useState<MlFeaturePreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

  // O algoritmo é consequência do tipo de problema, não uma escolha solta:
  // alvo 0/1 pede logística, alvo contínuo pede linear.
  const algorithm = task === 'binary' ? 'logistic' : 'linear'

  async function runPreview() {
    setPreviewing(true)
    setErr(null)
    try {
      setPreview(await api<MlFeaturePreview>('/api/v1/ml/preview', {
        method: 'POST',
        body: JSON.stringify({ featureSql, targetColumn, task, excludedColumns: excluded }),
      }))
    } catch (e) {
      setPreview(null)
      setErr((e as ApiError).message)
    } finally {
      setPreviewing(false)
    }
  }

  async function save() {
    setSaving(true)
    setErr(null)
    try {
      await api(isEdit ? `/api/v1/ml/${initial!.slug}` : '/api/v1/ml', {
        method: isEdit ? 'PUT' : 'POST',
        body: JSON.stringify({
          slug: slug.trim(), name, description, task, algorithm,
          featureSql, targetColumn: targetColumn.trim(), excludedColumns: excluded,
          holdoutPct: Number(holdoutPct), maxRows: Number(maxRows), retrain,
        }),
      })
      onSaved()
    } catch (e) {
      setErr((e as ApiError).message)
    } finally {
      setSaving(false)
    }
  }

  const toggleExcluded = (c: string) =>
    setExcluded(excluded.includes(c) ? excluded.filter((x) => x !== c) : [...excluded, c])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[94vh] w-full max-w-[820px] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-card-lg dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2.5 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
          <Brain size={15} className="text-accent" />
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold">{isEdit ? 'Editar modelo' : 'Novo modelo'}</h2>
            <p className="text-[10.5px] text-zinc-500">
              O SQL roda sobre o lake — nenhuma carga nas fontes de produção.
            </p>
          </div>
          <button onClick={onClose} aria-label="Fechar" className="ml-auto rounded p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nome">
              <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} placeholder="Risco de cancelamento em 90 dias" />
            </Field>
            <Field label="Identificador">
              <input className={INPUT} value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="churn-90d" />
            </Field>
          </div>

          <div className="mt-3">
            <Field label="Descrição">
              <input className={INPUT} value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="O que o modelo prevê e como a área usa o resultado" />
            </Field>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Tipo de problema" hint={task === 'binary'
              ? 'Alvo é sim/não (cancelou, inadimpliu). Usa regressão logística.'
              : 'Alvo é um número (receita, consumo). Usa regressão linear.'}>
              <select className={INPUT} value={task} onChange={(e) => { setTask(e.target.value as MlTask); setPreview(null) }}>
                <option value="binary">Classificação — sim ou não</option>
                <option value="regression">Regressão — um número</option>
              </select>
            </Field>
            <Field label="Coluna alvo" hint="A coluna que o modelo aprende a prever.">
              <input className={INPUT} value={targetColumn} onChange={(e) => setTargetColumn(e.target.value)} placeholder="cancelou" />
            </Field>
          </div>

          <div className="mt-3">
            <Field label="SQL da base de atributos" hint="Somente SELECT sobre conjuntos do lake, referenciados pelo apelido com underscore.">
              <textarea
                className={`${INPUT} h-[152px] resize-y font-mono text-[11px] leading-relaxed`}
                value={featureSql}
                onChange={(e) => { setFeatureSql(e.target.value); setPreview(null) }}
                placeholder={EXAMPLE}
                spellCheck={false}
              />
            </Field>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => void runPreview()}
              disabled={previewing || !featureSql.trim() || !targetColumn.trim()}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[11.5px] font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:text-zinc-900 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
            >
              {previewing ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} strokeWidth={1.6} />}
              Prever atributos
            </button>
            <span className="text-[10.5px] text-zinc-400">
              Mostra o que vira coluna do modelo antes de gastar um treino.
            </span>
          </div>

          {preview && (
            <div className="mt-3 rounded-xl border border-zinc-200 dark:border-zinc-800">
              <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
                <span className="text-[11px] font-semibold">Prévia</span>
                <span className="text-[10.5px] tabular-nums text-zinc-500">
                  {preview.sampledRows.toLocaleString('pt-BR')} linha(s) amostrada(s) · {preview.featureCount} atributo(s)
                </span>
              </div>

              <div className="px-3 py-2.5">
                <p className="mb-1.5 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-zinc-500">
                  Viram atributo
                </p>
                <div className="flex flex-wrap gap-1">
                  {preview.features.slice(0, 40).map((f) => (
                    <span key={f} className="rounded bg-zinc-100 px-1.5 py-px font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      {f}
                    </span>
                  ))}
                  {preview.features.length > 40 && (
                    <span className="text-[10px] text-zinc-400">+{preview.features.length - 40}</span>
                  )}
                </div>

                {preview.dropped.length > 0 && (
                  <>
                    <p className="mb-1.5 mt-3 flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-warn dark:text-warn-dark">
                      <AlertTriangle size={11} /> Descartadas
                    </p>
                    <ul className="flex flex-col gap-0.5">
                      {preview.dropped.map((d) => (
                        <li key={d.column} className="text-[10.5px] text-zinc-500">
                          <code className="font-mono text-zinc-600 dark:text-zinc-300">{d.column}</code> — {d.reason}
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                <p className="mb-1.5 mt-3 flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-zinc-500">
                  <Ban size={11} /> Excluir do treino
                </p>
                <p className="mb-1.5 text-[10.5px] leading-snug text-zinc-400">
                  Marque o que não pode entrar: identificadores e, principalmente, qualquer coluna que só existe
                  DEPOIS do fato que você quer prever — ela vazaria a resposta e o modelo pareceria perfeito.
                </p>
                <div className="flex flex-wrap gap-1">
                  {preview.columns.filter((c) => c !== targetColumn).map((c) => {
                    const on = excluded.includes(c)
                    return (
                      <button key={c} type="button" onClick={() => toggleExcluded(c)}
                        className={`rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors ${
                          on
                            ? 'border-transparent bg-crit-soft text-crit dark:bg-crit/15 dark:text-crit-dark'
                            : 'border-zinc-200 text-zinc-500 hover:border-zinc-300 dark:border-zinc-700'}`}>
                        {c}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          )}

          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Field label="Validação (%)" hint="Fatia separada antes do ajuste.">
              <input className={INPUT} type="number" min="5" max="50" value={holdoutPct}
                onChange={(e) => setHoldoutPct(e.target.value)} />
            </Field>
            <Field label="Teto de linhas" hint="Protege a memória do servidor.">
              <input className={INPUT} type="number" min="100" step="1000" value={maxRows}
                onChange={(e) => setMaxRows(e.target.value)} />
            </Field>
            <Field label="Retreino" hint="Ainda não automatizado — em breve.">
              <select className={INPUT} value={retrain} onChange={(e) => setRetrain(e.target.value as MlModel['retrain'])}>
                <option value="manual">Manual</option>
                <option value="daily">Diário</option>
                <option value="weekly">Semanal</option>
              </select>
            </Field>
          </div>

          {err && (
            <p className="mt-3 rounded-lg bg-crit-soft px-2.5 py-2 text-[11.5px] leading-relaxed text-crit dark:bg-crit/15 dark:text-crit-dark">{err}</p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
          <button onClick={onClose} className="rounded-lg border border-zinc-200 px-3 py-1.5 text-[12px] font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
            Cancelar
          </button>
          <button onClick={() => void save()} disabled={saving || !name || !slug || !featureSql || !targetColumn}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-zinc-950 transition-colors hover:bg-accent-hover disabled:opacity-50">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} strokeWidth={2.4} />}
            {isEdit ? 'Salvar' : 'Criar modelo'}
          </button>
        </footer>
      </div>
    </div>
  )
}
