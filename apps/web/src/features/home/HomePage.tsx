// Início: onboarding guiado quando vazio (ciente do papel) e, com conteúdo, a
// visão geral operável do lake — barra de métricas, pipeline por camada
// (Bronze/Prata/Ouro), conjuntos com frescor e atalhos.
//
// Densidade: uma barra de métricas no lugar de quatro cards soltos, tabela de
// 33px por linha e nenhum título acima de 20px. A camada de cada conjunto
// aparece em toda listagem — é como o analista sabe se pode confiar no número.
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Database, GitMerge, LayoutDashboard, Ruler, Sparkles, ArrowRight, BadgeCheck,
  Plug, ShieldCheck, Compass, Clock, Boxes, Layers, Table2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { DashboardSummary, DatasetSummary } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import OfficialBadge from '@/components/OfficialBadge'
import KpiBar, { type Kpi } from '@/components/ui/KpiBar'
import { Card, CardHead } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import TierBadge, { tierOf, TIER_HINT, type Tier } from '@/components/ui/TierBadge'
import { DataGrid, Th, Tr, Td, EntityCell } from '@/components/ui/DataGrid'

// ── Frescor ────────────────────────────────────────────────────────────────
// Horas desde a última sincronização. Um conjunto atrasado é um número errado
// esperando para ser usado — por isso o frescor vem antes da contagem de linhas.
function hoursSince(iso: string | null): number | null {
  if (!iso) return null
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000
  return Number.isFinite(h) ? h : null
}

function freshnessLabel(h: number | null): string {
  if (h === null) return '—'
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`
  if (h < 48) return `${Math.round(h)} h`
  return `${Math.round(h / 24)} d`
}

// Janela diária: até 26h é a cadência normal; acima disso a janela pulou.
function freshnessTone(h: number | null): 'ok' | 'warn' | 'crit' | 'neutral' {
  if (h === null) return 'neutral'
  if (h <= 26) return 'ok'
  if (h <= 72) return 'warn'
  return 'crit'
}

function compact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} M`
  if (n >= 1_000) return `${(n / 1_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} k`
  return n.toLocaleString('pt-BR')
}

// ── Onboarding (estado vazio) ──────────────────────────────────────────────
interface Step { icon: LucideIcon; title: string; desc: string; to: string; cta: string }

function OnboardingStep({ n, step }: { n: number; step: Step }) {
  const { icon: Icon } = step
  return (
    <div className="flex items-start gap-2.5 rounded-2xl border border-zinc-200 bg-white p-3.5 shadow-card dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent-ink dark:bg-zinc-800 dark:text-secondary">
        {n}
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-[12.5px] font-medium">
          <Icon size={14} strokeWidth={1.5} className="text-accent" /> {step.title}
        </p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-zinc-500">{step.desc}</p>
        <Link to={step.to} className="mt-2 inline-flex items-center gap-1 text-[11.5px] font-medium text-info hover:underline dark:text-info-dark">
          {step.cta} <ArrowRight size={12} strokeWidth={1.8} />
        </Link>
      </div>
    </div>
  )
}

const ADMIN_STEPS: Step[] = [
  { icon: Plug, title: 'Conecte uma fonte de dados', desc: 'Bancos e sistemas ficam em Conexões (credenciais só no servidor).', to: '/admin/connections', cta: 'Abrir Conexões' },
  { icon: Database, title: 'Publique um conjunto', desc: 'Escolha uma tabela da fonte e publique com um nome amigável — vira um conjunto explorável.', to: '/admin/connections', cta: 'Publicar conjunto' },
  { icon: ShieldCheck, title: 'Crie times e conceda acesso', desc: 'Defina quais times consultam cada conjunto — o acesso é fechado por padrão.', to: '/admin/access', cta: 'Usuários e Acessos' },
]
const EDITOR_STEPS: Step[] = [
  { icon: GitMerge, title: 'Crie um conjunto calculado', desc: 'Junte e trate conjuntos já sincronizados com SQL — sem pesar nas fontes.', to: '/datasets/derived/new', cta: 'Novo calculado' },
  { icon: LayoutDashboard, title: 'Monte um painel', desc: 'Widgets a partir das métricas dos seus conjuntos.', to: '/dashboards', cta: 'Ir para Painéis' },
  { icon: Compass, title: 'Explore os dados', desc: 'Filtre, agrupe e exporte no Explorador.', to: '/datasets', cta: 'Ver catálogo' },
]

function Onboarding({ isAdmin, isEditor, name }: { isAdmin: boolean; isEditor: boolean; name: string }) {
  const steps = isAdmin ? ADMIN_STEPS : isEditor ? EDITOR_STEPS : []
  return (
    <div className="mt-3.5">
      <div className="rounded-2xl border border-accent-line bg-accent-soft p-3.5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-[15px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">Vamos começar</h2>
        <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-zinc-600 dark:text-zinc-400">
          {isAdmin
            ? 'Seu hub ainda está vazio. Em poucos passos você conecta uma fonte, publica conjuntos e libera o acesso para os times.'
            : isEditor
              ? 'Comece criando um conjunto calculado a partir dos dados já disponíveis, ou monte um painel.'
              : 'Você ainda não recebeu acesso a nenhum conjunto.'}
        </p>
      </div>

      {steps.length > 0 ? (
        <div className="mt-3 grid gap-2.5 sm:grid-cols-3">
          {steps.map((s, i) => <OnboardingStep key={s.title} n={i + 1} step={s} />)}
        </div>
      ) : (
        <div className="mt-3 flex items-start gap-3 rounded-2xl border border-zinc-200 bg-white p-3 shadow-card dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-ink dark:bg-zinc-800 dark:text-secondary">
            <Clock size={16} strokeWidth={1.5} />
          </div>
          <div>
            <p className="text-[12.5px] font-medium">Aguardando acesso</p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500">
              {name.split(' ')[0]}, assim que um administrador incluir você (ou o seu time) em um conjunto de dados,
              ele aparece aqui e no catálogo. Fale com o time responsável pelo Data Hub para solicitar acesso.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Pipeline por camada ────────────────────────────────────────────────────
function Lane({ tier, datasets }: { tier: Tier; datasets: DatasetSummary[] }) {
  const bar = tier === 'bronze'
    ? 'bg-tier-bronze dark:bg-tier-bronze-dark'
    : tier === 'prata'
      ? 'bg-tier-prata dark:bg-tier-prata-dark'
      : 'bg-tier-ouro dark:bg-tier-ouro-dark'
  return (
    <div className="relative border-l border-zinc-200 px-3 pb-3 pt-2.5 first:border-l-0 dark:border-zinc-800">
      <span className={`absolute inset-x-0 top-0 h-0.5 ${bar}`} />
      <div className="flex items-center gap-2">
        <TierBadge tier={tier} />
        <span className="ml-auto text-[10.5px] tabular-nums text-zinc-400">{datasets.length}</span>
      </div>
      <p className="mb-2 mt-0.5 text-[10.5px] leading-snug text-zinc-500">{TIER_HINT[tier]}</p>
      <div className="space-y-px">
        {datasets.slice(0, 5).map((d) => {
          const h = hoursSince(d.lastSyncAt)
          const tone = freshnessTone(h)
          return (
            <Link key={d.id} to={`/datasets/${d.slug}`}
              className="flex items-center gap-2 rounded px-1.5 py-1 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
              {d.kind === 'derived'
                ? <GitMerge size={12} strokeWidth={1.5} className="shrink-0 text-zinc-400" />
                : <Database size={12} strokeWidth={1.5} className="shrink-0 text-zinc-400" />}
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-zinc-600 dark:text-zinc-400">
                {d.slug}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-zinc-400">
                {d.rowCount !== null ? compact(d.rowCount) : `${d.fieldCount} campos`}
              </span>
              <span
                title={`Sincronizado há ${freshnessLabel(h)}`}
                className={`h-[5px] w-[5px] shrink-0 rounded-full ${
                  tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-warn' : tone === 'crit' ? 'bg-crit' : 'bg-zinc-300 dark:bg-zinc-700'
                }`}
              />
            </Link>
          )
        })}
        {datasets.length === 0 && (
          <p className="px-1.5 py-2 text-[11px] text-zinc-400">Nenhum conjunto nesta camada.</p>
        )}
        {datasets.length > 5 && (
          <p className="px-1.5 pt-1 text-[10px] text-zinc-400">+{datasets.length - 5} conjunto(s)</p>
        )}
      </div>
    </div>
  )
}

// ── Página ─────────────────────────────────────────────────────────────────
export default function HomePage() {
  const user = useAuthStore((s) => s.user)
  const isAdmin = !!user?.roles.includes('admin')
  const isEditor = !!user?.roles.some((r) => r === 'admin' || r === 'editor')
  const [dashboards, setDashboards] = useState<DashboardSummary[]>([])
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.allSettled([
      api<{ dashboards: DashboardSummary[] }>('/api/v1/dashboards').then((r) => setDashboards(r.dashboards)),
      api<{ datasets: DatasetSummary[] }>('/api/v1/datasets').then((r) => setDatasets(r.datasets)),
    ]).finally(() => setLoading(false))
  }, [])

  const view = useMemo(() => {
    const byTier: Record<Tier, DatasetSummary[]> = { bronze: [], prata: [], ouro: [] }
    let totalRows = 0
    const ages: number[] = []
    for (const d of datasets) {
      byTier[tierOf(d.kind, d.official)].push(d)
      if (d.rowCount !== null) totalRows += d.rowCount
      const h = hoursSince(d.lastSyncAt)
      if (h !== null) ages.push(h)
    }
    ages.sort((a, b) => a - b)
    const median = ages.length ? ages[Math.floor(ages.length / 2)] : null
    const stale = ages.filter((h) => h > 26).length
    // Mais recentes primeiro — é o que o analista quer conferir ao abrir a tela.
    const recent = [...datasets].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )
    return { byTier, totalRows, median, stale, recent }
  }, [datasets])

  const hasContent = datasets.length > 0 || dashboards.length > 0

  // Sem `spark`/`delta`: o hub ainda não guarda histórico dessas métricas, e
  // tendência inventada é pior que tendência ausente. Quando a tabela de
  // histórico existir, basta preencher os campos — a barra já os suporta.
  const kpis: Kpi[] = [
    {
      label: 'Conjuntos', icon: Boxes, value: String(datasets.length), to: '/datasets',
      foot: `${view.byTier.bronze.length} bronze · ${view.byTier.prata.length} prata · ${view.byTier.ouro.length} ouro`,
    },
    {
      label: 'Linhas no lake', icon: Layers, value: compact(view.totalRows),
      foot: 'materializadas em Parquet',
    },
    {
      label: 'Frescor mediano', icon: Clock,
      value: view.median !== null ? freshnessLabel(view.median) : '—',
      foot: view.stale
        ? `${view.stale} conjunto(s) atrasado(s)`
        : `${datasets.length} em dia`,
    },
    {
      label: 'Painéis', icon: LayoutDashboard, value: String(dashboards.length), to: '/dashboards',
      foot: `${dashboards.reduce((s, d) => s + d.widgetCount, 0)} widgets`,
    },
    {
      label: 'Camada ouro', icon: BadgeCheck, value: String(view.byTier.ouro.length), to: '/datasets',
      foot: 'certificados pela diretoria',
    },
  ]

  return (
    <div className="mx-auto max-w-[1440px]">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[17px] font-semibold tracking-tight">
            Olá, {user?.name.split(' ')[0]}
          </h1>
          <p className="mt-0.5 text-[12px] text-zinc-500">
            {hasContent ? 'O que você quer analisar hoje?' : 'Bem-vindo ao Data Hub da Sebratel.'}
          </p>
        </div>
        {hasContent && (
          <div className="flex items-center gap-1.5">
            {view.stale > 0
              ? <Pill tone="warn" dot>{view.stale} conjunto(s) atrasado(s)</Pill>
              : <Pill tone="ok" dot>Ingestão em dia</Pill>}
            <Pill>Sincronização diária</Pill>
          </div>
        )}
      </div>

      {loading ? (
        <div className="mt-3.5 grid gap-2.5">
          <div className="h-[76px] animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
          <div className="h-[210px] animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
        </div>
      ) : !hasContent ? (
        <Onboarding isAdmin={isAdmin} isEditor={isEditor} name={user?.name ?? ''} />
      ) : (
        <div className="mt-3.5 flex flex-col gap-2.5">
          <KpiBar items={kpis} />

          <div className="grid items-start gap-2.5 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="flex min-w-0 flex-col gap-2.5">
              {/* Pipeline do lakehouse */}
              <Card>
                <CardHead icon={Layers} title="Pipeline do lakehouse" sub={`${datasets.length} conjuntos · 3 camadas`}>
                  <Link to="/datasets" className="text-[11px] font-medium text-info hover:underline dark:text-info-dark">
                    Ver catálogo
                  </Link>
                </CardHead>
                <div className="grid sm:grid-cols-3">
                  <Lane tier="bronze" datasets={view.byTier.bronze} />
                  <Lane tier="prata" datasets={view.byTier.prata} />
                  <Lane tier="ouro" datasets={view.byTier.ouro} />
                </div>
              </Card>

              {/* Conjuntos recentes */}
              <Card>
                <CardHead icon={Table2} title="Atualizados recentemente" sub={`${Math.min(8, view.recent.length)} de ${datasets.length}`} />
                <DataGrid>
                  <thead>
                    <tr>
                      <Th>Conjunto</Th>
                      <Th className="w-[92px]">Camada</Th>
                      <Th right className="w-[96px]">Linhas</Th>
                      <Th right className="w-[72px]">Campos</Th>
                      <Th className="w-[88px]">Frescor</Th>
                      <Th className="w-[92px]">Estado</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.recent.slice(0, 8).map((d) => {
                      const h = hoursSince(d.lastSyncAt)
                      const tone = freshnessTone(h)
                      return (
                        <Tr key={d.id}>
                          <Td>
                            <Link to={`/datasets/${d.slug}`} className="block hover:text-info dark:hover:text-info-dark">
                              <EntityCell name={d.name} slug={d.slug}>
                                {d.kind === 'derived'
                                  ? <GitMerge size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />
                                  : <Database size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />}
                              </EntityCell>
                            </Link>
                          </Td>
                          <Td><TierBadge tier={tierOf(d.kind, d.official)} /></Td>
                          <Td right muted>{d.rowCount !== null ? d.rowCount.toLocaleString('pt-BR') : '—'}</Td>
                          <Td right muted>{d.fieldCount}</Td>
                          <Td muted>{freshnessLabel(h)}</Td>
                          <Td>
                            {tone === 'ok' && <Pill tone="ok">em dia</Pill>}
                            {tone === 'warn' && <Pill tone="warn">atrasado</Pill>}
                            {tone === 'crit' && <Pill tone="crit">parado</Pill>}
                            {tone === 'neutral' && <Pill>sem sync</Pill>}
                          </Td>
                        </Tr>
                      )
                    })}
                  </tbody>
                </DataGrid>
              </Card>
            </div>

            {/* Coluna lateral */}
            <div className="flex min-w-0 flex-col gap-2.5">
              {view.byTier.ouro.length > 0 && (
                <Card>
                  <CardHead icon={BadgeCheck} title="Relatórios oficiais">
                    <OfficialBadge />
                  </CardHead>
                  <div className="flex flex-col">
                    {view.byTier.ouro.slice(0, 5).map((d) => (
                      <Link key={d.id} to={`/datasets/${d.slug}`}
                        className="flex items-start gap-2.5 border-b border-zinc-200 px-3 py-2 transition-colors last:border-b-0 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/40">
                        <TierBadge tier="ouro" showLabel={false} className="mt-1" />
                        <span className="min-w-0">
                          <span className="block truncate text-[12px] font-medium">{d.name}</span>
                          <span className="block truncate text-[10.5px] text-zinc-500">
                            {d.description || 'Fonte de verdade da diretoria.'}
                          </span>
                        </span>
                      </Link>
                    ))}
                  </div>
                </Card>
              )}

              <Card>
                <CardHead icon={LayoutDashboard} title="Painéis recentes">
                  <Link to="/dashboards" className="text-[11px] font-medium text-info hover:underline dark:text-info-dark">
                    Ver todos
                  </Link>
                </CardHead>
                <div className="flex flex-col">
                  {dashboards.slice(0, 5).map((d) => (
                    <Link key={d.id} to={`/dashboards/${d.id}`}
                      className="flex items-center gap-2.5 border-b border-zinc-200 px-3 py-2 transition-colors last:border-b-0 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/40">
                      <LayoutDashboard size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{d.name}</span>
                      <span className="shrink-0 text-[10.5px] tabular-nums text-zinc-400">{d.widgetCount} widgets</span>
                    </Link>
                  ))}
                  {dashboards.length === 0 && (
                    <p className="px-3 py-2.5 text-center text-[11.5px] text-zinc-500">
                      Nenhum painel ainda — <Link to="/dashboards" className="font-medium text-info hover:underline dark:text-info-dark">crie o primeiro</Link>.
                    </p>
                  )}
                </div>
              </Card>

              <Card>
                <CardHead title="Atalhos" />
                <div className="flex flex-col">
                  <Link to="/metrics"
                    className="flex items-start gap-2.5 border-b border-zinc-200 px-3 py-2.5 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/40">
                    <Ruler size={15} strokeWidth={1.5} className="mt-px shrink-0 text-zinc-400" />
                    <span className="min-w-0">
                      <span className="block text-[12px] font-medium">Biblioteca de métricas</span>
                      <span className="block text-[10.5px] leading-snug text-zinc-500">
                        Definidas uma vez, usadas em painéis, APIs e no assistente.
                      </span>
                    </span>
                  </Link>
                  <Link to="/ai"
                    className="flex items-start gap-2.5 px-3 py-2.5 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                    <Sparkles size={15} strokeWidth={1.5} className="mt-px shrink-0 text-accent" />
                    <span className="min-w-0">
                      <span className="block text-[12px] font-medium">Assistente IA</span>
                      <span className="block text-[10.5px] leading-snug text-zinc-500">
                        Pergunte em linguagem natural — só sobre o que você pode ler.
                      </span>
                    </span>
                  </Link>
                </div>
              </Card>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
