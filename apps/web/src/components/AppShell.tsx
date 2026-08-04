// Layout base: sidebar de navegação + HEADER superior fixo (breadcrumb + menu
// de usuário) sobre um canvas cinza que dá profundidade aos cards. Padrão de
// app-shell corporativo: a sidebar e o header ficam fixos; só o conteúdo rola.
import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, Navigate, Link, useLocation } from 'react-router-dom'
import {
  Home, Boxes, LayoutDashboard, Sparkles, Plug, Settings, ShieldCheck, ScrollText,
  Moon, Sun, LogOut, Ruler, Zap, Activity, Webhook, ChevronDown, ChevronRight,
} from 'lucide-react'
import clsx from 'clsx'
import { useAuthStore } from '@/store/authStore'
import { useThemeStore } from '@/store/themeStore'

const NAV = [
  { to: '/', label: 'Início', sublabel: 'Visão geral', icon: Home, end: true },
  { to: '/datasets', label: 'Datasets', sublabel: 'Fontes e calculados', icon: Boxes },
  { to: '/dashboards', label: 'Dashboards', sublabel: 'Painéis e widgets', icon: LayoutDashboard },
  { to: '/metrics', label: 'Métricas', sublabel: 'Biblioteca de indicadores', icon: Ruler },
  { to: '/ai', label: 'Assistente IA', sublabel: 'Converse com os dados', icon: Sparkles },
  { to: '/integrations', label: 'Integrações', sublabel: 'Tokens e APIs', icon: Plug },
]

// Rótulos amigáveis por segmento de rota (para o breadcrumb dinâmico).
const CRUMB: Record<string, string> = {
  datasets: 'Datasets', dashboards: 'Dashboards', metrics: 'Métricas', ai: 'Assistente IA',
  integrations: 'Integrações', admin: 'Administração', connections: 'Conexões',
  monitor: 'Monitoramento', 'write-products': 'APIs de Escrita', access: 'Usuários e Acessos',
  audit: 'Auditoria', derived: 'Calculado', new: 'Novo',
}

function navItemClass({ isActive }: { isActive: boolean }) {
  return clsx(
    'flex items-center gap-3 rounded-2xl px-3 py-2.5 min-h-[44px] transition-all duration-300 ease-nexa',
    isActive
      ? 'bg-accent font-bold text-zinc-950 shadow-lg shadow-accent/20 dark:text-[#1a1a1a]'
      : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
  )
}

function NavItem({ to, label, sublabel, icon: Icon, end }: (typeof NAV)[number]) {
  return (
    <NavLink key={to} to={to} end={end} className={navItemClass}>
      {({ isActive }) => (
        <>
          <Icon size={16} strokeWidth={2} className={clsx('shrink-0', isActive ? 'text-[#1a1a1a]' : 'text-accent')} />
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-xs font-semibold">{label}</span>
            <span className={clsx('truncate text-[10px]', isActive ? 'text-[#1a1a1a]/70' : 'text-zinc-500/70 dark:text-zinc-500')}>
              {sublabel}
            </span>
          </div>
        </>
      )}
    </NavLink>
  )
}

// Breadcrumb derivado do caminho — mostra onde a pessoa está de forma dinâmica.
function Breadcrumb() {
  const { pathname } = useLocation()
  const segs = pathname.split('/').filter(Boolean)
  const crumbs = segs.map((seg, i) => ({
    label: CRUMB[seg] ?? decodeURIComponent(seg).replace(/-/g, ' '),
    to: '/' + segs.slice(0, i + 1).join('/'),
  }))
  return (
    <nav className="flex min-w-0 items-center gap-1.5 text-sm">
      <Link to="/" className="shrink-0 text-zinc-400 hover:text-accent"><Home size={15} /></Link>
      {crumbs.map((c, i) => (
        <span key={c.to} className="flex min-w-0 items-center gap-1.5">
          <ChevronRight size={13} className="shrink-0 text-zinc-300 dark:text-zinc-600" />
          {i === crumbs.length - 1
            ? <span className="truncate font-semibold capitalize">{c.label}</span>
            : <Link to={c.to} className="truncate capitalize text-zinc-500 hover:text-accent">{c.label}</Link>}
        </span>
      ))}
    </nav>
  )
}

function UserMenu() {
  const { user, logout } = useAuthStore()
  const { theme, toggle } = useThemeStore()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  if (!user) return null
  const avatar = user.picture
    ? <img src={user.picture} alt="" className="h-7 w-7 rounded-full ring-1 ring-zinc-200 dark:ring-zinc-700" referrerPolicy="no-referrer" />
    : <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-brand text-xs font-bold text-[#1a1a1a]">{user.name[0]}</div>
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-zinc-200 py-1 pl-1 pr-2 transition-colors hover:border-zinc-300 dark:border-zinc-700 dark:hover:border-zinc-600">
        {avatar}
        <span className="hidden max-w-[120px] truncate text-sm font-medium sm:block">{user.name}</span>
        <ChevronDown size={14} className="text-zinc-400" />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-60 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
          <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-zinc-500">{user.email}</p>
          </div>
          <button onClick={() => { toggle(); }} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-zinc-600 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800">
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />} Tema {theme === 'dark' ? 'claro' : 'escuro'}
          </button>
          <button onClick={logout} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-zinc-600 hover:bg-red-50 hover:text-red-600 dark:text-zinc-300 dark:hover:bg-red-950/30 dark:hover:text-red-400">
            <LogOut size={15} /> Sair
          </button>
        </div>
      )}
    </div>
  )
}

export default function AppShell() {
  const { user } = useAuthStore()
  const { theme, toggle } = useThemeStore()

  if (!user) return <Navigate to="/login" replace />
  const isAdmin = user.roles.includes('admin')
  const isEditor = user.roles.some((r) => r === 'admin' || r === 'editor')

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-50 dark:bg-zinc-950">
      <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        {/* Logo */}
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-zinc-200 px-4 dark:border-zinc-800">
          <img src="/logo-circular-sebratel.png" alt="Sebratel" className="h-8 w-8 shrink-0 rounded-full ring-1 ring-zinc-200 dark:ring-zinc-700" />
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-bold tracking-tight">Data Hub</span>
            <span className="text-[10px] font-medium uppercase tracking-widest text-zinc-500">Sebratel</span>
          </div>
        </div>

        {/* Nav */}
        <nav className="scrollbar-thin flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
          {NAV.map((item) => (
            <NavItem key={item.to} {...item} />
          ))}
          {isEditor && <NavItem to="/apis" label="APIs" sublabel="Construtor GET/POST" icon={Webhook} />}
          {isAdmin && (
            <>
              <div className="px-3 pb-1 pt-4 text-[10px] font-medium uppercase tracking-widest text-zinc-400">
                Administração
              </div>
              <NavItem to="/admin/connections" label="Conexões" sublabel="Fontes de dados" icon={Settings} />
              <NavItem to="/admin/monitor" label="Monitoramento" sublabel="Uptime das APIs" icon={Activity} />
              <NavItem to="/admin/access" label="Usuários e Acessos" sublabel="Papéis, times e permissões" icon={ShieldCheck} />
              <NavItem to="/admin/audit" label="Auditoria" sublabel="Histórico de ações" icon={ScrollText} />
            </>
          )}
        </nav>

        {/* Status pill — sincronização controlada (1x/dia, madrugada) */}
        <div className="mx-3 mb-3 rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            <span className="text-[10px] text-zinc-500">Lake ativo</span>
          </div>
          <div className="mt-1 flex items-center gap-1">
            <Zap size={9} className="text-secondary" />
            <span className="font-mono text-[10px] text-secondary">Sincronização diária</span>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Header superior fixo */}
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-zinc-200 bg-white/80 px-6 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/80">
          <Breadcrumb />
          <div className="flex items-center gap-2">
            <button onClick={toggle} title="Alternar tema"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 transition-colors hover:border-zinc-300 hover:text-accent dark:border-zinc-700 dark:hover:border-zinc-600">
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <UserMenu />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-6 lg:px-8">
          <div className="animate-fade-in">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
