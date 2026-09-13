// Registro de modelos preditivos — a lista.
//
// A coluna que importa é a QUALIDADE, não o nome: um modelo com AUC 0,58 está
// em produção respondendo bobagem, e isso precisa saltar da tabela sem ninguém
// abrir o detalhe. Por isso o veredito vem como pílula colorida ao lado.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Brain, Plus, Target, TrendingUp, AlertTriangle, Loader2, CircleDot, Clock,
} from 'lucide-react'
import type { MlModel } from '@datahub/shared'
import { api, ApiError } from '@/lib/api'
import KpiBar, { type Kpi } from '@/components/ui/KpiBar'
import { Card, CardHead } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { DataGrid, Th, Tr, Td, EntityCell } from '@/components/ui/DataGrid'
import { headline } from './metricsView'
import ModelDialog from './ModelDialog'

const TASK_LABEL: Record<string, string> = {
  binary: 'Classificação',
  regression: 'Regressão',
}
const RETRAIN_LABEL: Record<string, string> = {
  manual: 'manual', daily: 'diário', weekly: 'semanal',
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'agora'
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86400) return `${Math.floor(s / 3600)} h`
  return `${Math.floor(s / 86400)} d`
}

export default function ModelsPage() {
  const [models, setModels] = useState<MlModel[]>([])
  const [queued, setQueued] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const r = await api<{ models: MlModel[]; queued: number }>('/api/v1/ml')
      setModels(r.models)
      setQueued(r.queued)
    } catch (e) {
      setError((e as ApiError).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const view = useMemo(() => {
    const promoted = models.filter((m) => m.promoted_version_id)
    const weak = promoted.filter((m) => headline(m.task, m.promoted_metrics).verdict === 'crit')
    const failed = models.filter((m) => m.last_run_status === 'error')
    return { promoted, weak, failed }
  }, [models])

  const kpis: Kpi[] = [
    {
      label: 'Modelos', icon: Brain, value: String(models.length),
      foot: `${view.promoted.length} em produção`,
    },
    {
      label: 'Em produção', icon: Target, value: String(view.promoted.length),
      foot: view.weak.length ? `${view.weak.length} com qualidade baixa` : 'nenhum abaixo do aceitável',
    },
    {
      label: 'Treinos com erro', icon: AlertTriangle, value: String(view.failed.length),
      foot: view.failed.length ? 'último treino falhou' : 'último treino ok em todos',
    },
    {
      label: 'Na fila', icon: Clock, value: String(queued),
      foot: 'treino roda um por vez',
    },
  ]

  return (
    <div className="mx-auto min-w-0 max-w-[1600px]">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[17px] font-semibold tracking-tight">Modelos preditivos</h1>
          <p className="mt-0.5 text-[12px] text-zinc-500">
            Treinados sobre o lake, versionados e servidos pelo mesmo controle de acesso dos conjuntos.
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-zinc-950 transition-colors hover:bg-accent-hover active:scale-95"
        >
          <Plus size={14} strokeWidth={2} /> Novo modelo
        </button>
      </div>

      {error && (
        <div className="mt-3 flex items-center gap-2.5 rounded-2xl border border-crit/40 bg-crit-soft p-3 dark:bg-crit/10">
          <AlertTriangle size={15} className="shrink-0 text-crit dark:text-crit-dark" />
          <p className="text-[12px] text-crit dark:text-crit-dark">{error}</p>
          <button onClick={() => void load()} className="ml-auto text-[11.5px] font-medium text-info hover:underline dark:text-info-dark">
            Tentar de novo
          </button>
        </div>
      )}

      {loading ? (
        <div className="mt-3.5 grid gap-2.5">
          <div className="h-[76px] animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
          <div className="h-[220px] animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
        </div>
      ) : (
        <div className="mt-3.5 flex flex-col gap-2.5">
          <KpiBar items={kpis} />

          <Card>
            <CardHead icon={Brain} title="Registro" sub={`${models.length} modelo(s)`} />
            {models.length === 0 ? (
              <div className="px-3 py-10 text-center">
                <Brain size={26} strokeWidth={1.2} className="mx-auto mb-2 text-zinc-300 dark:text-zinc-700" />
                <p className="text-[12px] text-zinc-500">
                  Nenhum modelo ainda. Um modelo é um SQL que monta a base de atributos, uma coluna alvo e um algoritmo.
                </p>
                <button onClick={() => setCreating(true)} className="mt-1.5 text-[12px] font-medium text-info hover:underline dark:text-info-dark">
                  Criar o primeiro
                </button>
              </div>
            ) : (
              <DataGrid fixed>
                <thead>
                  <tr>
                    <Th>Modelo</Th>
                    <Th className="w-[112px]">Problema</Th>
                    <Th className="w-[132px]">Qualidade</Th>
                    <Th right className="w-[84px]">Versão</Th>
                    <Th right className="w-[96px]">Linhas</Th>
                    <Th className="w-[92px]">Retreino</Th>
                    <Th className="w-[116px]">Último treino</Th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => {
                    const h = headline(m.task, m.promoted_metrics)
                    return (
                      <Tr key={m.id}>
                        <Td>
                          <Link to={`/models/${m.slug}`} className="block hover:text-info dark:hover:text-info-dark">
                            <EntityCell name={m.name} slug={m.slug}>
                              <Brain size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />
                            </EntityCell>
                          </Link>
                        </Td>
                        <Td muted>{TASK_LABEL[m.task] ?? m.task}</Td>
                        <Td>
                          {h.verdict === 'neutral' ? (
                            <span className="text-[11px] text-zinc-400">não treinado</span>
                          ) : (
                            <span className="flex items-center gap-1.5" title={h.hint}>
                              <Pill tone={h.verdict}>{h.label} {h.value}</Pill>
                            </span>
                          )}
                        </Td>
                        <Td right muted>
                          {m.promoted_version ? `v${m.promoted_version}` : '—'}
                          {m.version_count && m.version_count > 1
                            ? <span className="text-zinc-400"> /{m.version_count}</span>
                            : null}
                        </Td>
                        <Td right muted>{m.rows_trained ? m.rows_trained.toLocaleString('pt-BR') : '—'}</Td>
                        <Td muted>{RETRAIN_LABEL[m.retrain] ?? m.retrain}</Td>
                        <Td>
                          {m.last_run_status === 'running' && (
                            <span className="flex items-center gap-1.5 text-[11px] text-info dark:text-info-dark">
                              <Loader2 size={11} className="animate-spin" /> treinando
                            </span>
                          )}
                          {m.last_run_status === 'error' && (
                            <span title={m.last_run_error ?? ''}><Pill tone="crit">falhou</Pill></span>
                          )}
                          {m.last_run_status === 'done' && (
                            <span className="text-[11px] tabular-nums text-zinc-500">há {timeAgo(m.last_run_at)}</span>
                          )}
                          {!m.last_run_status && <span className="text-[11px] text-zinc-400">nunca</span>}
                        </Td>
                      </Tr>
                    )
                  })}
                </tbody>
              </DataGrid>
            )}
          </Card>

          {/* Nota de leitura: sem isto, "AUC 0,72" não significa nada para quem
              não é da área — e é justamente quem decide usar o modelo. */}
          <div className="flex items-start gap-2.5 rounded-2xl border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
            <CircleDot size={14} strokeWidth={1.5} className="mt-px shrink-0 text-zinc-400" />
            <p className="text-[11px] leading-relaxed text-zinc-500">
              <b className="text-zinc-700 dark:text-zinc-300">Como ler a qualidade.</b>{' '}
              Na classificação, <b>AUC</b> é a chance de o modelo dar nota maior a um caso positivo do que a um
              negativo — 0,5 é sorteio, acima de 0,8 é utilizável. Na regressão, <b>R²</b> é a fatia da variação
              que o modelo explica — 0 equivale a chutar sempre a média. Ambos são medidos sobre a fatia de
              validação, que o modelo não viu no treino.
            </p>
          </div>

          <p className="flex items-center gap-1.5 px-1 text-[10.5px] text-zinc-400">
            <TrendingUp size={11} strokeWidth={1.5} />
            Predição em lote e simulação ficam dentro de cada modelo.
          </p>
        </div>
      )}

      {creating && (
        <ModelDialog initial={null} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); void load() }} />
      )}
    </div>
  )
}
