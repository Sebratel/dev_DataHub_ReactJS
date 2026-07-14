// Layout base: sidebar de navegação + header com tema e usuário.
// O usuário final só vê conceitos amigáveis (Conjuntos de Dados, Dashboards…).
import { NavLink, Outlet, Navigate } from 'react-router-dom'
import {
  Home, Boxes, LayoutDashboard, Sparkles, Plug, Settings,
  Moon, Sun, LogOut, Database,
} from 'lucide-react'
import clsx from 'clsx'
import { useAuthStore } from '@/store/authStore'
import { useThemeStore } from '@/store/themeStore'

const NAV = [
  { to: '/', label: 'Início', icon: Home, end: true },
  { to: '/datasets', label: 'Conjuntos de Dados', icon: Boxes },
  { to: '/dashboards', label: 'Dashboards', icon: LayoutDashboard },
  { to: '/ai', label: 'Assistente IA', icon: Sparkles },
  { to: '/integrations', label: 'Integrações', icon: Plug },
]

export default function AppShell() {
  const { user, logout } = useAuthStore()
  const { theme, toggle } = useThemeStore()

  if (!user) return <Navigate to="/login" replace />
  const isAdmin = user.roles.includes('admin')

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-white">
            <Database size={16} />
          </div>
          <span className="font-semibold">Data Hub</span>
        </div>
        <nav className="flex-1 space-y-0.5 px-2 py-2">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition',
                  isActive
                    ? 'bg-accent-soft font-medium text-accent dark:bg-zinc-800 dark:text-white'
                    : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
                )
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
          {isAdmin && (
            <>
              <div className="px-3 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wider text-zinc-400">
                Administração
              </div>
              <NavLink
                to="/admin/connections"
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition',
                    isActive
                      ? 'bg-accent-soft font-medium text-accent dark:bg-zinc-800 dark:text-white'
                      : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
                  )
                }
              >
                <Settings size={16} />
                Conexões
              </NavLink>
            </>
          )}
        </nav>
        <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
          <div className="flex items-center gap-2.5">
            {user.picture
              ? <img src={user.picture} alt="" className="h-8 w-8 rounded-full" />
              : <div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-200 text-xs font-medium dark:bg-zinc-700">{user.name[0]}</div>}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="truncate text-xs text-zinc-500">{user.email}</p>
            </div>
          </div>
          <div className="mt-3 flex gap-1.5">
            <button
              onClick={toggle}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
              Tema
            </button>
            <button
              onClick={logout}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              <LogOut size={14} />
              Sair
            </button>
          </div>
        </div>
      </aside>
      <main className="flex-1 overflow-x-hidden p-8">
        <Outlet />
      </main>
    </div>
  )
}
