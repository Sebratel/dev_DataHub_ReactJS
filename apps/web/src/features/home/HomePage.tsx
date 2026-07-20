// Home: onboarding guiado quando vazio (ciente do papel) e, com conteúdo,
// visão geral do lake — números, relatórios oficiais, dashboards e conjuntos.
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Database, GitMerge, LayoutDashboard, Ruler, Sparkles, ArrowRight, BadgeCheck,
  Plug, ShieldCheck, Compass, Clock,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { DashboardSummary, DatasetSummary } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import OfficialBadge from '@/components/OfficialBadge'

function StatTile({ icon: Icon, label, value, to }: {
  icon: LucideIcon; label: string; value: number; to: string
}) {
  return (
    <Link to={to}
      className="hover-lift rounded-2xl border border-zinc-200 bg-white p-4 shadow-card hover:border-accent dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-400">
        <Icon size={13} /> {label}
      </div>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </Link>
  )
}

interface Step { icon: LucideIcon; title: string; desc: string; to: string; cta: string }

function OnboardingStep({ n, step }: { n: number; step: Step }) {
  const { icon: Icon } = step
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-card dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-bold text-secondary dark:bg-zinc-800">
        {n}
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-semibold"><Icon size={15} className="text-accent" /> {step.title}</p>
        <p className="mt-0.5 text-xs text-zinc-500">{step.desc}</p>
        <Link to={step.to} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
          {step.cta} <ArrowRight size={12} />
        </Link>
      </div>
    </div>
  )
}

const ADMIN_STEPS: Step[] = [
  { icon: Plug, title: 'Conecte uma fonte de dados', desc: 'Bancos e sistemas ficam em Administração › Conexões (credenciais só no servidor).', to: '/admin/connections', cta: 'Abrir Conexões' },
  { icon: Database, title: 'Publique um conjunto', desc: 'Escolha uma tabela da fonte e publique com um nome amigável — vira um conjunto explorável.', to: '/admin/connections', cta: 'Publicar conjunto' },
  { icon: ShieldCheck, title: 'Crie times e conceda acesso', desc: 'Defina quais times consultam cada conjunto — o acesso é fechado por padrão.', to: '/admin/access', cta: 'Usuários e Acessos' },
]
const EDITOR_STEPS: Step[] = [
  { icon: GitMerge, title: 'Crie um conjunto derivado', desc: 'Junte e trate conjuntos já sincronizados com SQL — sem pesar nas fontes.', to: '/datasets/derived/new', cta: 'Novo derivado' },
  { icon: LayoutDashboard, title: 'Monte um dashboard', desc: 'Widgets a partir das métricas dos seus conjuntos.', to: '/dashboards', cta: 'Ir para Dashboards' },
  { icon: Compass, title: 'Explore os dados', desc: 'Filtre, agrupe e exporte no Explorador.', to: '/datasets', cta: 'Ver catálogo' },
]

function Onboarding({ isAdmin, isEditor, name }: { isAdmin: boolean; isEditor: boolean; name: string }) {
  const steps = isAdmin ? ADMIN_STEPS : isEditor ? EDITOR_STEPS : []
  return (
    <div className="mt-6">
      <div className="rounded-2xl border border-accent/40 bg-gradient-to-br from-accent-soft to-transparent p-6 shadow-card dark:border-zinc-800 dark:from-zinc-900 dark:to-zinc-950">
        <h2 className="text-lg font-semibold">Vamos começar 🚀</h2>
        <p className="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
          {isAdmin
            ? 'Seu hub ainda está vazio. Em poucos passos você conecta uma fonte, publica conjuntos e libera o acesso para os times.'
            : isEditor
              ? 'Comece criando um conjunto derivado a partir dos dados já disponíveis, ou monte um dashboard.'
              : 'Você ainda não recebeu acesso a nenhum conjunto de dados.'}
        </p>
      </div>

      {steps.length > 0 ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {steps.map((s, i) => <OnboardingStep key={s.title} n={i + 1} step={s} />)}
        </div>
      ) : (
        // Viewer sem acesso — orientação clara (acesso fechado por padrão).
        <div className="mt-4 flex items-start gap-3 rounded-2xl border border-zinc-200 bg-white p-5 shadow-card dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-secondary dark:bg-zinc-800">
            <Clock size={18} />
          </div>
          <div>
            <p className="text-sm font-medium">Aguardando acesso</p>
            <p className="mt-0.5 text-sm text-zinc-500">
              {name.split(' ')[0]}, assim que um administrador incluir você (ou o seu time) em um conjunto de dados,
              ele aparece aqui e no catálogo. Fale com o time responsável pelo Data Hub para solicitar acesso.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

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

  const sources = useMemo(() => datasets.filter((d) => d.kind === 'source'), [datasets])
  const deriveds = useMemo(() => datasets.filter((d) => d.kind === 'derived'), [datasets])
  const officials = useMemo(() => datasets.filter((d) => d.official), [datasets])
  const hasContent = datasets.length > 0 || dashboards.length > 0

  return (
    <div className="mx-auto max-w-5xl animate-fade-in">
      <h1 className="text-2xl font-semibold tracking-tight">Olá, {user?.name.split(' ')[0]} 👋</h1>
      <p className="mt-1 text-sm text-zinc-500">
        {hasContent ? 'O que você quer analisar hoje?' : 'Bem-vindo ao Data Hub da Sebratel.'}
      </p>

      {loading ? (
        <p className="mt-8 text-sm text-zinc-500">Carregando…</p>
      ) : !hasContent ? (
        <Onboarding isAdmin={isAdmin} isEditor={isEditor} name={user?.name ?? ''} />
      ) : (
        <>
          {/* Visão geral */}
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile icon={Database} label="Fontes" value={sources.length} to="/datasets" />
            <StatTile icon={GitMerge} label="Derivados" value={deriveds.length} to="/datasets" />
            <StatTile icon={LayoutDashboard} label="Dashboards" value={dashboards.length} to="/dashboards" />
            <StatTile icon={BadgeCheck} label="Oficiais" value={officials.length} to="/datasets" />
          </div>

          {/* Relatórios oficiais em destaque */}
          {officials.length > 0 && (
            <>
              <div className="mt-8 flex items-center gap-2">
                <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-400">Relatórios oficiais</h2>
                <OfficialBadge />
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {officials.slice(0, 4).map((d) => (
                  <Link key={d.id} to={`/datasets/${d.slug}`}
                    className="hover-lift group flex items-start gap-3 rounded-2xl border border-accent/40 bg-white p-4 shadow-card ring-1 ring-accent/20 hover:border-accent dark:bg-zinc-900">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-brand text-[#1a1a1a]">
                      {d.kind === 'derived' ? <GitMerge size={17} /> : <Database size={17} />}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium group-hover:text-accent">{d.name}</p>
                      <p className="line-clamp-1 text-xs text-zinc-500">{d.description || 'Fonte de verdade da diretoria.'}</p>
                    </div>
                  </Link>
                ))}
              </div>
            </>
          )}

          {/* Dashboards recentes */}
          <div className="mt-8 flex items-center justify-between">
            <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-400">Dashboards recentes</h2>
            <Link to="/dashboards" className="flex items-center gap-1 text-xs text-accent hover:underline">
              ver todos <ArrowRight size={12} />
            </Link>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {dashboards.slice(0, 3).map((d) => (
              <Link key={d.id} to={`/dashboards/${d.id}`}
                className="hover-lift group rounded-2xl border border-zinc-200 bg-white p-4 shadow-card hover:border-accent dark:border-zinc-800 dark:bg-zinc-900">
                <LayoutDashboard size={16} className="text-accent" />
                <p className="mt-2 truncate text-sm font-medium group-hover:text-accent">{d.name}</p>
                <p className="text-xs text-zinc-500">{d.widgetCount} widgets</p>
              </Link>
            ))}
            {dashboards.length === 0 && (
              <p className="col-span-3 rounded-2xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
                Nenhum dashboard ainda — <Link to="/dashboards" className="text-accent hover:underline">crie o primeiro</Link>.
              </p>
            )}
          </div>

          {/* Conjuntos de dados */}
          <div className="mt-8 flex items-center justify-between">
            <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-400">Conjuntos de dados</h2>
            <Link to="/datasets" className="flex items-center gap-1 text-xs text-accent hover:underline">
              ver catálogo <ArrowRight size={12} />
            </Link>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {datasets.slice(0, 6).map((d) => (
              <Link key={d.id} to={`/datasets/${d.slug}`}
                className="hover-lift group rounded-2xl border border-zinc-200 bg-white p-4 shadow-card hover:border-accent dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex items-center justify-between">
                  {d.kind === 'derived'
                    ? <GitMerge size={16} className="text-secondary" />
                    : <Database size={16} className="text-accent" />}
                  {d.official && <OfficialBadge />}
                </div>
                <p className="mt-2 truncate text-sm font-medium group-hover:text-accent">{d.name}</p>
                <p className="text-xs text-zinc-500">
                  {d.rowCount !== null ? `${d.rowCount.toLocaleString('pt-BR')} registros` : `${d.fieldCount} campos`}
                </p>
              </Link>
            ))}
          </div>

          {/* Atalhos */}
          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            <Link to="/metrics" className="hover-lift flex items-center gap-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-card hover:border-accent dark:border-zinc-800 dark:bg-zinc-900">
              <Ruler size={18} className="text-accent" />
              <span>
                <p className="text-sm font-medium">Biblioteca de Métricas</p>
                <p className="text-xs text-zinc-500">Receita, chamados, clientes ativos — definidos uma vez, usados em tudo.</p>
              </span>
            </Link>
            <Link to="/ai" className="hover-lift flex items-center gap-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-card hover:border-accent dark:border-zinc-800 dark:bg-zinc-900">
              <Sparkles size={18} className="text-accent" />
              <span>
                <p className="text-sm font-medium">Assistente IA</p>
                <p className="text-xs text-zinc-500">Pergunte em linguagem natural sobre os seus dados.</p>
              </span>
            </Link>
          </div>
        </>
      )}
    </div>
  )
}
