import { Boxes, LayoutDashboard, Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'

// Home do MVP — os cards viram "recentes/favoritos/sugestões" nos próximos sprints.
const CARDS = [
  { to: '/datasets', icon: Boxes, title: 'Conjuntos de Dados', text: 'Explore os dados publicados: clientes, contratos, financeiro e mais.' },
  { to: '/dashboards', icon: LayoutDashboard, title: 'Dashboards', text: 'Crie e acompanhe indicadores com gráficos e KPIs.' },
  { to: '/ai', icon: Sparkles, title: 'Assistente IA', text: 'Pergunte em linguagem natural e receba análises prontas.' },
]

export default function HomePage() {
  const user = useAuthStore((s) => s.user)
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-semibold">Olá, {user?.name.split(' ')[0]} 👋</h1>
      <p className="mt-1 text-sm text-zinc-500">O que você quer analisar hoje?</p>
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {CARDS.map(({ to, icon: Icon, title, text }) => (
          <Link
            key={to}
            to={to}
            className="group rounded-xl border border-zinc-200 bg-white p-5 transition hover:border-accent hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
          >
            <Icon size={20} className="text-accent" />
            <h2 className="mt-3 font-medium group-hover:text-accent">{title}</h2>
            <p className="mt-1 text-sm text-zinc-500">{text}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}
