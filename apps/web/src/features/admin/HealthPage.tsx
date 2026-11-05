// Operar › Saúde da plataforma — a saúde do Data Hub numa tela só (MON-14).
//
// Responde, sem abrir dez telas: tem alguma coisa precisando de mim agora? O
// que falhou esta noite (T-MON-08)? A fila anda? O disco aguenta? É também o
// canal de aviso: o admin abre o sistema e vê, sem depender de e-mail ou chat.
//
// "Precisa de atenção agora" vem do ESTADO atual: cada item sai sozinho quando
// a causa é resolvida. O que já aconteceu fica no histórico de alertas.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity, AlertTriangle, CheckCircle2, RefreshCw, Database, GitMerge, ArrowRight, HardDrive, Cpu, ListOrdered,
} from 'lucide-react'
import clsx from 'clsx'
import type { PlatformHealth, PlatformProblem } from '@datahub/shared'
import { api } from '@/lib/api'
import { hoursSince, lagSince } from '@/lib/freshness'
import { Page, PageHeader, ErrorBanner, EmptyState, TableSkeleton } from '@/components/ui/Page'
import { Card, CardHead } from '@/components/ui/Card'
import { DataGrid, Th, Tr, Td, EntityCell } from '@/components/ui/DataGrid'
import { Pill } from '@/components/ui/Pill'
import KpiBar from '@/components/ui/KpiBar'
import AlertsCard from './AlertsCard'
import HealthChecksCard from './HealthChecksCard'
import { refreshAlertsBell } from '@/components/AlertsBell'

const AREA: Record<PlatformProblem['area'], string> = {
  carga: 'Carga', qualidade: 'Qualidade', integracao: 'Integração', infraestrutura: 'Infraestrutura',
}

const fmt = (n: number) => n.toLocaleString('pt-BR')
function fmtBytes(b: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = b
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toLocaleString('pt-BR', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${u[i]}`
}

export default function HealthPage() {
  const [h, setH] = useState<PlatformHealth | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  function load() {
    setLoading(true)
    api<PlatformHealth>('/api/v1/platform/health')
      .then((r) => { setH(r); setError(null) })
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar a saúde da plataforma.'))
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    load()
    // A tela fica aberta numa aba: atualiza sozinha, sem ninguém clicar.
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [])

  const crit = h?.problems.filter((p) => p.severity === 'crit').length ?? 0
  const disk = h?.disk

  return (
    <Page>
      <PageHeader
        icon={Activity}
        title="Saúde da plataforma"
        subtitle="Tudo que precisa de atenção no Data Hub, numa tela. Atualiza sozinha a cada minuto."
      >
        <button onClick={load} disabled={loading}
          className="flex h-[30px] items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 text-[12px] font-medium hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800">
          <RefreshCw size={13} className={clsx(loading && 'animate-spin')} /> Atualizar
        </button>
      </PageHeader>
      {error && <ErrorBanner message={error} onRetry={load} />}

      {h === null && !error ? <TableSkeleton /> : h && (
        <div className="flex flex-col gap-2.5">
          <KpiBar items={[
            {
              label: 'Precisam de atenção', value: fmt(h.problems.length), icon: AlertTriangle,
              foot: h.problems.length ? `${crit} crítico(s)` : 'nada pendente',
            },
            {
              label: 'Cargas com erro (24 h)', value: fmt(h.runs24h.error), icon: ListOrdered,
              foot: `de ${fmt(h.runs24h.total)} execuções`,
            },
            {
              label: 'Fila de cargas', value: h.queue.running ? 'carregando' : 'parada', icon: Database,
              foot: h.queue.running ? `${h.queue.running.name} · ${fmt(h.queue.waiting)} esperando` : `${fmt(h.queue.waiting)} esperando`,
            },
            {
              label: 'Motor de consulta', value: `${h.engine.normal + h.engine.adhoc}`, unit: ` / ${h.engine.maxNormal + h.engine.maxAdhoc}`, icon: Cpu,
              foot: h.engine.queued ? `${fmt(h.engine.queued)} consulta(s) esperando vaga` : 'sem fila',
            },
            {
              label: 'Disco do lake', value: disk ? `${disk.usedPercent.toLocaleString('pt-BR')}` : '—', unit: disk ? '%' : undefined, icon: HardDrive,
              foot: disk ? `${fmtBytes(disk.freeBytes)} livres · aviso em ${disk.warnPercent}%` : 'sem leitura do volume',
            },
          ]} />

          <ProblemasCard problems={h.problems} />

          <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <FalhasCard h={h} />
            <AlertsCard onSeen={() => { load(); refreshAlertsBell() }} />
          </div>

          {disk && (
            <p className="text-[11px] text-zinc-500">
              Volume do lake: {fmtBytes(disk.totalBytes)} no total, {fmtBytes(disk.lakeBytes)} em conjuntos
              {disk.stagingBytes > 0 ? `, ${fmtBytes(disk.stagingBytes)} em arquivos temporários de carga` : ''}.
              Os maiores conjuntos estão em <Link to="/admin/autotune" className="text-info hover:underline dark:text-info-dark">Padronizar atualização</Link>.
            </p>
          )}

          <HealthChecksCard onChange={load} />
        </div>
      )}
    </Page>
  )
}

function ProblemasCard({ problems }: { problems: PlatformProblem[] }) {
  return (
    <Card>
      <CardHead icon={AlertTriangle} title="Precisa de atenção agora"
        sub="cada item sai da lista sozinho quando a causa é resolvida" />
      {problems.length === 0 ? (
        <EmptyState icon={CheckCircle2}
          message="Nada precisa de atenção agora: nenhuma carga parada ou falhando, nenhuma conferência divergente, endpoints no ar e disco com folga." />
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {problems.map((p) => (
            <li key={p.id} className="flex items-start gap-3 px-3 py-2.5">
              <span className={clsx('mt-[3px] h-[18px] w-1 shrink-0 rounded-full', p.severity === 'crit' ? 'bg-crit' : 'bg-warn')} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Pill tone={p.severity === 'crit' ? 'crit' : 'warn'}>{p.severity === 'crit' ? 'crítico' : 'atenção'}</Pill>
                  <span className="text-[10.5px] uppercase tracking-[0.06em] text-zinc-400">{AREA[p.area]}</span>
                  <span className="min-w-0 text-[12px] font-semibold">{p.title}</span>
                </div>
                <p className="mt-0.5 text-[11.5px] text-zinc-500">{p.detail}</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1 text-[10.5px] tabular-nums text-zinc-400">
                {p.since && <span title={`Desde ${new Date(p.since).toLocaleString('pt-BR')}`}>{lagSince(hoursSince(p.since))}</span>}
                {p.link && (
                  <Link to={p.link} className="flex items-center gap-1 font-medium text-info hover:underline dark:text-info-dark">
                    Abrir <ArrowRight size={11} />
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

// Numa janela de 24 h, "11:02" pode ser hoje ou ontem: o dia vai junto quando não é hoje.
function quandoNas24h(iso: string): string {
  const d = new Date(iso)
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? hora : `ontem ${hora}`
}

// "O que falhou esta noite?" — fontes e calculados juntos, numa tela (T-MON-08).
function FalhasCard({ h }: { h: PlatformHealth }) {
  const f = h.runs24h.failures
  return (
    <Card>
      <CardHead icon={ListOrdered} title="Falhas nas últimas 24 h"
        sub={`${fmt(h.runs24h.done)} concluídas · ${fmt(h.runs24h.error)} com erro · ${fmt(h.runs24h.cancelled)} canceladas`} />
      {f.length === 0 ? (
        <EmptyState icon={CheckCircle2} message="Nenhuma carga nem materialização falhou nas últimas 24 horas." />
      ) : (
        <div className="max-h-[420px] overflow-auto">
          <DataGrid fixed className="min-w-[560px]">
            <thead>
              <tr>
                <Th className="w-[96px]">Quando</Th>
                <Th className="w-[210px]">Conjunto</Th>
                <Th>Erro</Th>
              </tr>
            </thead>
            <tbody>
              {f.map((r) => (
                <Tr key={r.id}>
                  <Td muted title={new Date(r.startedAt).toLocaleString('pt-BR')}>
                    <span className="text-[11px] tabular-nums">{quandoNas24h(r.startedAt)}</span>
                  </Td>
                  <Td>
                    <Link to={`/datasets/${r.slug}`} className="block hover:text-info dark:hover:text-info-dark">
                      <EntityCell name={r.name} slug={r.kind === 'derived' ? 'calculado' : r.slug}>
                        {r.kind === 'derived'
                          ? <GitMerge size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />
                          : <Database size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />}
                      </EntityCell>
                    </Link>
                  </Td>
                  <Td muted title={r.error ?? undefined}>
                    <span className="line-clamp-2 whitespace-normal text-[11px]">{r.error ?? '—'}</span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </DataGrid>
        </div>
      )}
    </Card>
  )
}
