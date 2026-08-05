// Detalhe do modelo: qualidade da versão em produção, o que pesa na decisão,
// histórico de versões e predição em lote.
//
// A ordem da página é a ordem das perguntas de quem vai usar: "esse número
// presta?" → "por quê?" → "melhorou ou piorou?" → "me dá a lista".
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  Brain, Play, ArrowLeft, Loader2, AlertTriangle, Pencil, CheckCircle2,
  History, ListOrdered, Download, Info,
} from 'lucide-react'
import type { MlModel, MlVersion, MlRun, MlTrainOutcome } from '@datahub/shared'
import { api, ApiError } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { Card, CardHead } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { DataGrid, Th, Tr, Td, MiniBar } from '@/components/ui/DataGrid'
import { headline, metricRows } from './metricsView'
import ModelDialog from './ModelDialog'

const fmtMs = (ms: number | null) => (ms == null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`)
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR') : '—')

export default function ModelDetailPage() {
  const { slug = '' } = useParams()
  const isAdmin = !!useAuthStore((s) => s.user)?.roles.includes('admin')

  const [model, setModel] = useState<MlModel | null>(null)
  const [versions, setVersions] = useState<MlVersion[]>([])
  const [runs, setRuns] = useState<MlRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [training, setTraining] = useState(false)
  const [lastTrain, setLastTrain] = useState<MlTrainOutcome | null>(null)
  const [editing, setEditing] = useState(false)

  const [predicting, setPredicting] = useState(false)
  const [predictions, setPredictions] = useState<{ rows: Record<string, unknown>[]; scored: number } | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const r = await api<{ model: MlModel; versions: MlVersion[]; runs: MlRun[] }>(`/api/v1/ml/${slug}`)
      setModel(r.model)
      setVersions(r.versions)
      setRuns(r.runs)
    } catch (e) {
      setError((e as ApiError).message)
    } finally {
      setLoading(false)
    }
  }, [slug])

  useEffect(() => { void load() }, [load])

  async function train() {
    setTraining(true)
    setError(null)
    setLastTrain(null)
    try {
      setLastTrain(await api<MlTrainOutcome>(`/api/v1/ml/${slug}/train`, { method: 'POST' }))
      await load()
    } catch (e) {
      setError((e as ApiError).message)
    } finally {
      setTraining(false)
    }
  }

  async function promote(versionId: string) {
    try {
      await api(`/api/v1/ml/${slug}/promote/${versionId}`, { method: 'POST' })
      await load()
    } catch (e) {
      setError((e as ApiError).message)
    }
  }

  async function predict() {
    setPredicting(true)
    setError(null)
    try {
      const r = await api<{ rows: Record<string, unknown>[]; scored: number }>(`/api/v1/ml/${slug}/predict`, {
        method: 'POST', body: JSON.stringify({ limit: 100 }),
      })
      setPredictions(r)
    } catch (e) {
      setError((e as ApiError).message)
    } finally {
      setPredicting(false)
    }
  }

  function exportCsv() {
    if (!predictions?.rows.length) return
    const cols = Object.keys(predictions.rows[0])
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v)
      return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const csv = [cols.join(';'), ...predictions.rows.map((r) => cols.map((c) => esc(r[c])).join(';'))].join('\r\n')
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${slug}-predicoes.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) {
    return <div className="mx-auto max-w-[1440px]"><div className="h-[420px] animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-900" /></div>
  }
  if (!model) {
    return (
      <div className="mx-auto max-w-[1440px]">
        <p className="text-[12px] text-zinc-500">{error ?? 'Modelo não encontrado.'}</p>
        <Link to="/models" className="mt-2 inline-block text-[12px] font-medium text-info hover:underline dark:text-info-dark">Voltar</Link>
      </div>
    )
  }

  const promotedVersion = versions.find((v) => v.promoted) ?? null
  const h = headline(model.task, promotedVersion?.metrics ?? model.promoted_metrics)
  const importances = promotedVersion?.importances ?? []
  const maxAbs = importances.length ? Math.max(...importances.map((i) => i.abs)) : 1

  return (
    <div className="mx-auto max-w-[1440px]">
      <Link to="/models" className="inline-flex items-center gap-1 text-[11.5px] text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
        <ArrowLeft size={12} strokeWidth={1.8} /> Modelos
      </Link>

      <div className="mt-1.5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
            <Brain size={17} strokeWidth={1.5} className="text-accent" /> {model.name}
          </h1>
          <p className="mt-0.5 text-[12px] text-zinc-500">
            {model.description || <span className="font-mono text-[11px]">{model.slug}</span>}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setEditing(true)}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[12px] font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-300">
            <Pencil size={13} strokeWidth={1.6} /> Editar
          </button>
          <button onClick={() => void train()} disabled={training}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-zinc-950 transition-colors hover:bg-accent-hover disabled:opacity-60">
            {training ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} strokeWidth={2} />}
            {training ? 'Treinando…' : 'Treinar agora'}
          </button>
        </div>
      </div>

      {training && (
        <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-zinc-500">
          <Info size={12} className="shrink-0" />
          O treino roda um por vez no servidor. Grandes bases levam alguns minutos — pode deixar a aba aberta.
        </p>
      )}

      {error && (
        <div className="mt-3 flex items-start gap-2.5 rounded-2xl border border-crit/40 bg-crit-soft p-3 dark:bg-crit/10">
          <AlertTriangle size={15} className="mt-px shrink-0 text-crit dark:text-crit-dark" />
          <p className="text-[12px] leading-relaxed text-crit dark:text-crit-dark">{error}</p>
        </div>
      )}

      {lastTrain && (
        <div className="mt-3 flex items-start gap-2.5 rounded-2xl border border-ok/40 bg-ok-soft p-3 dark:bg-ok/10">
          <CheckCircle2 size={15} className="mt-px shrink-0 text-ok dark:text-ok-dark" />
          <div className="min-w-0 text-[11.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">
            <b>Versão {lastTrain.version} treinada.</b>{' '}
            {lastTrain.rowsTrained.toLocaleString('pt-BR')} linhas de treino e{' '}
            {lastTrain.rowsHoldout.toLocaleString('pt-BR')} de validação.
            {lastTrain.skippedRows > 0 && (
              <> {lastTrain.skippedRows.toLocaleString('pt-BR')} linha(s) descartada(s) por alvo ausente.</>
            )}
            {lastTrain.dropped.length > 0 && (
              <> Colunas descartadas: {lastTrain.dropped.map((d) => d.column).join(', ')}.</>
            )}
          </div>
        </div>
      )}

      <div className="mt-3 grid items-start gap-2.5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-2.5">
          {/* Qualidade */}
          <Card>
            <CardHead icon={CheckCircle2} title="Qualidade em produção"
              sub={promotedVersion ? `versão ${promotedVersion.version}` : 'sem versão promovida'} />
            {!promotedVersion ? (
              <p className="px-3 py-6 text-center text-[12px] text-zinc-500">
                Nenhuma versão promovida ainda. Treine o modelo para gerar a primeira.
              </p>
            ) : (
              <>
                <div className="flex items-center gap-3 border-b border-zinc-200 px-3 py-3 dark:border-zinc-800">
                  <div>
                    <p className="text-[9.5px] font-semibold uppercase tracking-[0.09em] text-zinc-500">{h.label}</p>
                    <p className="text-[26px] font-semibold leading-none tracking-[-0.03em] tabular-nums">{h.value}</p>
                  </div>
                  <Pill tone={h.verdict}>
                    {h.verdict === 'ok' ? 'utilizável' : h.verdict === 'warn' ? 'fraco' : 'não confiável'}
                  </Pill>
                  <p className="ml-auto max-w-[46ch] text-right text-[10.5px] leading-snug text-zinc-400">{h.hint}</p>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3">
                  {metricRows(model.task, promotedVersion.metrics).map((r) => (
                    <div key={r.label} title={r.hint}
                      className="border-b border-l border-zinc-200 px-3 py-2 first:border-l-0 dark:border-zinc-800">
                      <p className="text-[9.5px] font-semibold uppercase tracking-[0.09em] text-zinc-500">{r.label}</p>
                      <p className="mt-0.5 text-[13px] font-medium tabular-nums">{r.value}</p>
                    </div>
                  ))}
                </div>
                <p className="px-3 py-2 text-[10.5px] text-zinc-400">
                  Medido sobre {promotedVersion.rows_holdout?.toLocaleString('pt-BR') ?? '—'} linhas de validação
                  que o modelo não viu · treino em {fmtMs(promotedVersion.trained_ms)}
                </p>
              </>
            )}
          </Card>

          {/* Importâncias */}
          {importances.length > 0 && (
            <Card>
              <CardHead icon={ListOrdered} title="O que pesa na decisão" sub="atributos padronizados" />
              <div className="flex flex-col">
                {importances.slice(0, 12).map((imp) => (
                  <div key={imp.feature} className="flex items-center gap-2.5 border-b border-zinc-200 px-3 py-1.5 last:border-b-0 dark:border-zinc-800">
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-600 dark:text-zinc-300">{imp.feature}</span>
                    <MiniBar pct={(imp.abs / maxAbs) * 100} />
                    <span className={`w-[62px] shrink-0 text-right text-[11px] font-medium tabular-nums ${
                      imp.weight >= 0 ? 'text-crit dark:text-crit-dark' : 'text-info dark:text-info-dark'}`}>
                      {imp.weight >= 0 ? '+' : ''}{imp.weight.toFixed(3)}
                    </span>
                  </div>
                ))}
              </div>
              <p className="border-t border-zinc-200 px-3 py-2 text-[10.5px] leading-snug text-zinc-400 dark:border-zinc-800">
                Peso positivo empurra a previsão para cima, negativo para baixo. Como os atributos foram
                padronizados, os valores são comparáveis entre si — mas indicam <b>associação</b>, não causa.
              </p>
            </Card>
          )}

          {/* Predição em lote */}
          <Card>
            <CardHead icon={Play} title="Predição em lote" sub="maiores primeiro">
              {predictions && predictions.rows.length > 0 && (
                <button onClick={exportCsv} className="flex items-center gap-1 text-[11px] font-medium text-info hover:underline dark:text-info-dark">
                  <Download size={11} /> CSV
                </button>
              )}
              <button onClick={() => void predict()} disabled={predicting || !promotedVersion}
                className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1 text-[11px] font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:text-zinc-900 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300">
                {predicting ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} strokeWidth={1.8} />}
                Rodar
              </button>
            </CardHead>
            {!predictions ? (
              <p className="px-3 py-6 text-center text-[12px] text-zinc-500">
                {promotedVersion
                  ? 'Roda o modelo sobre a própria base de atributos e devolve os 100 de maior pontuação.'
                  : 'Treine e promova uma versão para poder predizer.'}
              </p>
            ) : predictions.rows.length === 0 ? (
              <p className="px-3 py-6 text-center text-[12px] text-zinc-500">Nenhuma linha retornada.</p>
            ) : (
              <>
                <DataGrid>
                  <thead>
                    <tr>
                      {Object.keys(predictions.rows[0]).map((c) => (
                        <Th key={c} right={c === 'probabilidade' || c === 'previsao'}>{c}</Th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {predictions.rows.slice(0, 25).map((row, i) => (
                      <Tr key={i}>
                        {Object.entries(row).map(([c, v]) => {
                          const isScore = c === 'probabilidade' || c === 'previsao'
                          return (
                            <Td key={c} right={isScore} muted={!isScore}>
                              {isScore
                                ? <span className="font-medium">{Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 4 })}</span>
                                : String(v ?? '')}
                            </Td>
                          )
                        })}
                      </Tr>
                    ))}
                  </tbody>
                </DataGrid>
                <p className="border-t border-zinc-200 px-3 py-2 text-[10.5px] text-zinc-400 dark:border-zinc-800">
                  Mostrando {Math.min(25, predictions.rows.length)} de {predictions.rows.length} ·
                  {' '}{predictions.scored.toLocaleString('pt-BR')} linha(s) pontuada(s) no total
                </p>
              </>
            )}
          </Card>
        </div>

        {/* Lateral: versões e histórico */}
        <div className="flex min-w-0 flex-col gap-2.5">
          <Card>
            <CardHead icon={History} title="Versões" sub={`${versions.length}`} />
            {versions.length === 0 ? (
              <p className="px-3 py-5 text-center text-[12px] text-zinc-500">Nenhuma versão ainda.</p>
            ) : (
              <div className="flex flex-col">
                {versions.map((v) => {
                  const vh = headline(model.task, v.metrics)
                  return (
                    <div key={v.id} className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 last:border-b-0 dark:border-zinc-800">
                      <span className="w-[34px] shrink-0 text-[11.5px] font-medium tabular-nums">v{v.version}</span>
                      <Pill tone={vh.verdict}>{vh.label} {vh.value}</Pill>
                      <span className="ml-auto shrink-0 text-[10px] tabular-nums text-zinc-400">
                        {new Date(v.created_at).toLocaleDateString('pt-BR')}
                      </span>
                      {v.promoted ? (
                        <Pill tone="ok" dot>produção</Pill>
                      ) : isAdmin ? (
                        <button onClick={() => void promote(v.id)}
                          className="shrink-0 text-[10.5px] font-medium text-info hover:underline dark:text-info-dark">
                          promover
                        </button>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}
            <p className="border-t border-zinc-200 px-3 py-2 text-[10.5px] leading-snug text-zinc-400 dark:border-zinc-800">
              Versões são imutáveis. Voltar atrás é promover a anterior — sem retreinar.
            </p>
          </Card>

          <Card>
            <CardHead icon={History} title="Treinos" sub={`${runs.length} recente(s)`} />
            {runs.length === 0 ? (
              <p className="px-3 py-5 text-center text-[12px] text-zinc-500">Nenhum treino ainda.</p>
            ) : (
              <div className="flex flex-col">
                {runs.map((r) => (
                  <div key={r.id} className="flex items-start gap-2 border-b border-zinc-200 px-3 py-2 last:border-b-0 dark:border-zinc-800">
                    <div className="min-w-0 flex-1">
                      <p className="text-[11.5px] tabular-nums text-zinc-600 dark:text-zinc-300">{fmtDate(r.started_at)}</p>
                      <p className="text-[10px] text-zinc-400">
                        {r.trigger === 'manual' ? 'manual' : 'agendado'}
                        {r.rows ? ` · ${r.rows.toLocaleString('pt-BR')} linhas` : ''}
                      </p>
                      {r.error && <p className="mt-0.5 text-[10.5px] leading-snug text-crit dark:text-crit-dark">{r.error}</p>}
                    </div>
                    <span className="shrink-0">
                      {r.status === 'done' && <Pill tone="ok">ok</Pill>}
                      {r.status === 'error' && <Pill tone="crit">erro</Pill>}
                      {r.status === 'running' && <Pill tone="info">rodando</Pill>}
                      {r.status === 'canceled' && <Pill>cancelado</Pill>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <CardHead title="Definição" />
            <div className="flex flex-col gap-2 px-3 py-2.5">
              <div className="flex items-baseline gap-2">
                <span className="w-[74px] shrink-0 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-zinc-500">Alvo</span>
                <span className="font-mono text-[11px]">{model.target_column}</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="w-[74px] shrink-0 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-zinc-500">Algoritmo</span>
                <span className="text-[11.5px]">{model.algorithm === 'logistic' ? 'Regressão logística' : 'Regressão linear'}</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="w-[74px] shrink-0 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-zinc-500">Validação</span>
                <span className="text-[11.5px] tabular-nums">{model.holdout_pct}%</span>
              </div>
              {model.excluded_columns.length > 0 && (
                <div className="flex items-baseline gap-2">
                  <span className="w-[74px] shrink-0 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-zinc-500">Excluídas</span>
                  <span className="min-w-0 font-mono text-[10.5px] text-zinc-500">{model.excluded_columns.join(', ')}</span>
                </div>
              )}
              <details className="mt-1">
                <summary className="cursor-pointer text-[10.5px] font-medium text-info dark:text-info-dark">Ver SQL de atributos</summary>
                <pre className="mt-1.5 overflow-x-auto rounded-lg bg-zinc-50 p-2 font-mono text-[10px] leading-relaxed text-zinc-600 dark:bg-zinc-950 dark:text-zinc-400">
                  {model.feature_sql}
                </pre>
              </details>
            </div>
          </Card>
        </div>
      </div>

      {editing && (
        <ModelDialog initial={model} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void load() }} />
      )}
    </div>
  )
}
