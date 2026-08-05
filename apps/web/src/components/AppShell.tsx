// Layout base: rail de navegação em CARVÃO + header superior fixo (breadcrumb
// + estado do motor + menu de usuário) sobre um canvas cinza-frio.
//
// O rail é escuro nos DOIS temas — padrão das plataformas de monitoramento: o
// chrome é constante e o conteúdo é que muda. O tom vem do matiz do laranja da
// marca com a saturação quase zerada (ver `rail` no tailwind.config), então o
// âmbar do item ativo parece da mesma família em vez de um adesivo num chrome
// frio. Quente no chrome, frio no conteúdo — é o conteúdo que precisa de
// neutralidade para número e texto ficarem legíveis.
//
// A navegação é AGRUPADA por intenção (Explorar / Construir / Operar) em vez de
// uma lista plana: com 10+ destinos a lista plana obriga a ler tudo toda vez.
import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, Navigate, Link, useLocation } from 'react-router-dom'
import {
  Home, Boxes, LayoutDashboard, Sparkles, Plug, ShieldCheck, ScrollText,
  Moon, Sun, LogOut, Ruler, Activity, Webhook, ChevronDown, Search, Database, Radio, Brain, NotebookText,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import clsx from 'clsx'
import { useAuthStore } from '@/store/authStore'
import { useThemeStore } from '@/store/themeStore'

interface NavEntry {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
  /** Papel mínimo para o item aparecer. */
  role?: 'editor' | 'admin'
}

const NAV_GROUPS: { title: string; items: NavEntry[] }[] = [
  {
    title: 'Explorar',
    items: [
      { to: '/', label: 'Início', icon: Home, end: true },
      { to: '/datasets', label: 'Conjuntos', icon: Boxes },
      { to: '/dashboards', label: 'Painéis', icon: LayoutDashboard },
      { to: '/metrics', label: 'Métricas', icon: Ruler },
    ],
  },
  {
    title: 'Construir',
    items: [
      { to: '/notebooks', label: 'Notebooks', icon: NotebookText },
      { to: '/ai', label: 'Assistente IA', icon: Sparkles },
      { to: '/models', label: 'Modelos', icon: Brain, role: 'editor' },
      { to: '/integrations', label: 'Integrações', icon: Plug },
      { to: '/apis', label: 'APIs', icon: Webhook, role: 'editor' },
      { to: '/gateway', label: 'Gateway', icon: Radio, role: 'editor' },
    ],
  },
  {
    title: 'Operar',
    items: [
      { to: '/admin/monitor', label: 'Monitoramento', icon: Activity, role: 'admin' },
      { to: '/admin/connections', label: 'Conexões', icon: Database, role: 'admin' },
      { to: '/admin/access', label: 'Usuários e Acessos', icon: ShieldCheck, role: 'admin' },
      { to: '/admin/audit', label: 'Auditoria', icon: ScrollText, role: 'admin' },
    ],
  },
]

// Rótulos amigáveis por segmento de rota (para o breadcrumb dinâmico).
const CRUMB: Record<string, string> = {
  datasets: 'Conjuntos', dashboards: 'Painéis', metrics: 'Métricas', ai: 'Assistente IA',
  integrations: 'Integrações', admin: 'Administração', connections: 'Conexões',
  monitor: 'Monitoramento', 'write-products': 'APIs de Escrita', access: 'Usuários e Acessos',
  audit: 'Auditoria', derived: 'Calculado', new: 'Novo', apis: 'APIs', explore: 'Explorador',
  gateway: 'Gateway', models: 'Modelos', notebooks: 'Notebooks',
}

function NavItem({ to, label, icon: Icon, end }: NavEntry) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => clsx(
        'flex h-[29px] items-center gap-2.5 rounded-lg px-2 text-[12.5px] transition-colors duration-150',
        isActive
          ? 'bg-rail-active font-medium text-white shadow-[inset_2px_0_0_theme(colors.accent.DEFAULT)]'
          : 'text-rail-muted hover:bg-rail-raised hover:text-rail-ink',
      )}
    >
      {({ isActive }) => (
        <>
          <Icon
            size={15}
            strokeWidth={1.4}
            className={clsx('shrink-0', isActive ? 'text-secondary' : 'text-rail-faint')}
          />
          <span className="truncate">{label}</span>
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
    <nav className="flex min-w-0 items-center gap-1.5 text-[12px]">
      <Link to="/" className="shrink-0 font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
        Data Hub
      </Link>
      {crumbs.map((c, i) => (
        <span key={c.to} className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-zinc-300 dark:text-zinc-700">/</span>
          {i === crumbs.length - 1
            ? <span className="truncate font-medium capitalize">{c.label}</span>
            : <Link to={c.to} className="truncate capitalize text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">{c.label}</Link>}
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
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])
  if (!user) return null
  const initials = user.name.split(' ').filter(Boolean).slice(0, 2).map((n) => n[0]).join('').toUpperCase()
  const avatar = user.picture
    ? <img src={user.picture} alt="" className="h-[26px] w-[26px] rounded-full" referrerPolicy="no-referrer" />
    : <div className="flex h-[26px] w-[26px] items-center justify-center rounded-full bg-gradient-to-br from-zinc-500 to-zinc-700 text-[10.5px] font-semibold text-white">{initials}</div>
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-lg p-0.5 pr-1.5 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        {avatar}
        <ChevronDown size={13} strokeWidth={1.6} className="text-zinc-400" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1.5 w-56 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-card-lg dark:border-zinc-800 dark:bg-zinc-900">
          <div className="border-b border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
            <p className="truncate text-[12.5px] font-medium">{user.name}</p>
            <p className="truncate text-[11px] text-zinc-500">{user.email}</p>
          </div>
          <button onClick={toggle} role="menuitem"
            className="flex w-full items-center gap-2.5 px-3 py-2 text-[12px] text-zinc-600 transition-colors hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800">
            {theme === 'dark' ? <Sun size={14} strokeWidth={1.5} /> : <Moon size={14} strokeWidth={1.5} />}
            Tema {theme === 'dark' ? 'claro' : 'escuro'}
          </button>
          <button onClick={logout} role="menuitem"
            className="flex w-full items-center gap-2.5 px-3 py-2 text-[12px] text-zinc-600 transition-colors hover:bg-crit-soft hover:text-crit dark:text-zinc-300 dark:hover:bg-crit/15 dark:hover:text-crit-dark">
            <LogOut size={14} strokeWidth={1.5} /> Sair
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
  const allowed = (e: NavEntry) =>
    !e.role || (e.role === 'admin' ? isAdmin : isEditor)

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-50 dark:bg-zinc-950">
      {/* ── Rail grafite ─────────────────────────────────────────── */}
      <aside className="flex w-[216px] shrink-0 flex-col border-r border-rail-edge bg-rail text-rail-ink">
        <div className="flex h-[46px] shrink-0 items-center gap-2.5 border-b border-rail-raised px-3">
          <img src="/logo-circular-sebratel.png" alt="" className="h-[22px] w-[22px] shrink-0 rounded-md" />
          <div className="min-w-0 leading-tight">
            <span className="block text-[12.5px] font-semibold tracking-tight">Data Hub</span>
            <span className="block text-[9px] uppercase tracking-[0.14em] text-rail-faint">Sebratel</span>
          </div>
        </div>

        {/* Busca — hoje é atalho visual para o catálogo; vira paleta ⌘K depois. */}
        <Link
          to="/datasets"
          className="mx-2.5 mb-1 mt-2.5 flex h-7 shrink-0 items-center gap-2 rounded-lg border border-rail-active bg-rail-raised px-2 text-[11.5px] text-rail-faint transition-colors hover:border-rail-faint hover:text-rail-muted"
        >
          <Search size={13} strokeWidth={1.5} className="shrink-0" />
          <span className="truncate">Buscar conjuntos…</span>
        </Link>

        <nav className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-2.5 pt-1.5">
          {NAV_GROUPS.map((group) => {
            const items = group.items.filter(allowed)
            if (!items.length) return null
            return (
              <div key={group.title}>
                <div className="px-1.5 pb-1 pt-3 text-[9px] font-semibold uppercase tracking-[0.13em] text-rail-faint">
                  {group.title}
                </div>
                <div className="space-y-px">
                  {items.map((item) => <NavItem key={item.to} {...item} />)}
                </div>
              </div>
            )
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-2 border-t border-rail-raised px-2.5 py-2">
          <span className="relative flex h-1.5 w-1.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ok" />
          </span>
          <div className="min-w-0 leading-tight">
            <span className="block text-[10.5px] font-medium text-rail-ink">Lake ativo</span>
            <span className="block text-[9.5px] text-rail-faint">Sincronização diária</span>
          </div>
        </div>
      </aside>

      {/* ── Conteúdo ─────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-[46px] shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-3.5 dark:border-zinc-800 dark:bg-zinc-900">
          <Breadcrumb />
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <button
              onClick={toggle}
              title={`Tema ${theme === 'dark' ? 'claro' : 'escuro'}`}
              aria-label={`Alternar para tema ${theme === 'dark' ? 'claro' : 'escuro'}`}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              {theme === 'dark' ? <Sun size={15} strokeWidth={1.5} /> : <Moon size={15} strokeWidth={1.5} />}
            </button>
            <UserMenu />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto overflow-x-hidden px-3.5 py-3.5">
          <div className="animate-fade-in">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
