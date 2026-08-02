// Layout base: sidebar de navegação + rodapé de usuário, no mesmo padrão
// visual do churn_mvp (pills âmbar, sublabels, logo circular Sebratel).
// O usuário final só vê conceitos amigáveis (Conjuntos de Dados, Dashboards…).
import { NavLink, Outlet, Navigate } from 'react-router-dom'
import {
  Home, Boxes, LayoutDashboard, Sparkles, Plug, Settings, ShieldCheck, ScrollText,
  Moon, Sun, LogOut, Ruler, Zap, Activity,
} from 'lucide-react'
import clsx from 'clsx'
import { useAuthStore } from '@/store/authStore'
import { useThemeStore } from '@/store/themeStore'

const NAV = [
  { to: '/', label: 'Início', sublabel: 'Visão geral', icon: Home, end: true },
  { to: '/datasets', label: 'Conjuntos de Dados', sublabel: 'Catálogo e exploração', icon: Boxes },
  { to: '/dashboards', label: 'Dashboards', sublabel: 'Painéis e widgets', icon: LayoutDashboard },
  { to: '/metrics', label: 'Métricas', sublabel: 'Biblioteca de indicadores', icon: Ruler },
  { to: '/ai', label: 'Assistente IA', sublabel: 'Converse com os dados', icon: Sparkles },
  { to: '/integrations', label: 'Integrações', sublabel: 'Tokens e APIs', icon: Plug },
]

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

export default function AppShell() {
  const { user, logout } = useAuthStore()
  const { theme, toggle } = useThemeStore()

  if (!user) return <Navigate to="/login" replace />
  const isAdmin = user.roles.includes('admin')

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-200 bg-zinc-100/60 dark:border-zinc-800 dark:bg-zinc-900">
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
        <div className="mx-3 mb-3 rounded-lg border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-950">
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

        {/* Usuário */}
        <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
          <div className="flex items-center gap-2.5">
            {user.picture
              ? <img src={user.picture} alt="" className="h-8 w-8 rounded-full ring-1 ring-zinc-200 dark:ring-zinc-700" referrerPolicy="no-referrer" />
              : <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-brand text-xs font-bold text-[#1a1a1a]">{user.name[0]}</div>}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="truncate text-xs text-zinc-500">{user.email}</p>
            </div>
          </div>
          <div className="mt-3 flex gap-1.5">
            <button
              onClick={toggle}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-white py-1.5 text-xs text-zinc-600 transition-all hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
              Tema
            </button>
            <button
              onClick={logout}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-white py-1.5 text-xs text-zinc-600 transition-all hover:border-red-300 hover:text-red-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:text-red-400"
            >
              <LogOut size={14} />
              Sair
            </button>
          </div>
        </div>
      </aside>
      <main className="flex-1 overflow-x-hidden p-6 animate-fade-in">
        <Outlet />
      </main>
    </div>
  )
}
