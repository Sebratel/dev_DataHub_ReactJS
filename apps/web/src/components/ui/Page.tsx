// Esqueleto de página — UM só para todo o app.
//
// Antes daqui existiam CINCO larguras de container diferentes (max-w-7xl,
// screen-2xl, 6xl, 5xl, [1440px]) e cada tela inventava o próprio cabeçalho.
// É isso que dava a sensação de sistema legado: nada alinhava entre telas, e
// o conteúdo pulava de largura ao navegar.
//
// `min-w-0` no container não é detalhe: sem ele, uma tabela larga dentro de
// um grid/flex força o track a crescer (um track `1fr` tem min-width:auto) e a
// PÁGINA INTEIRA passa a rolar na horizontal — foi exatamente o que acontecia
// na tela de conjunto calculado.
import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'
import { Search } from 'lucide-react'

export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={clsx('mx-auto min-w-0 max-w-[1600px]', className)}>
      {children}
    </div>
  )
}

// Cabeçalho padrão: título, subtítulo de contexto e ações à direita.
// Nenhum título passa de 17px — é o teto da escala.
export function PageHeader({ icon: Icon, title, subtitle, children, back }: {
  icon?: LucideIcon
  title: string
  subtitle?: string
  /** Ações à direita (botão primário, seletor). */
  children?: React.ReactNode
  /** Link de volta, quando a tela é um detalhe. */
  back?: React.ReactNode
}) {
  return (
    <div className="mb-3">
      {back}
      <div className={clsx('flex flex-wrap items-end justify-between gap-3', back && 'mt-1.5')}>
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
            {Icon && <Icon size={17} strokeWidth={1.5} className="shrink-0 text-zinc-400" />}
            <span className="truncate">{title}</span>
          </h1>
          {subtitle && <p className="mt-0.5 text-[12px] text-zinc-500">{subtitle}</p>}
        </div>
        {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
      </div>
    </div>
  )
}

// Barra de ferramentas acima de uma lista: filtros à esquerda, busca à direita.
export function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="mb-2.5 flex flex-wrap items-center gap-1.5">{children}</div>
}

export function SearchInput({ value, onChange, placeholder }: {
  value: string; onChange: (v: string) => void; placeholder?: string
}) {
  return (
    <div className="relative ml-auto min-w-[180px] max-w-[280px] flex-1">
      <Search size={13} strokeWidth={1.6} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-[30px] w-full rounded-lg border border-zinc-200 bg-white pl-8 pr-2.5 text-[12px] outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-zinc-800 dark:bg-zinc-900"
      />
    </div>
  )
}

// Filtro segmentado com contagem. A contagem é o que transforma um filtro em
// informação: "Fontes 182" já responde antes de clicar.
export function FilterChips<T extends string>({ value, onChange, options }: {
  value: T
  onChange: (v: T) => void
  options: { key: T; label: string; count?: number; icon?: LucideIcon }[]
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
      {options.map(({ key, label, count, icon: Icon }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={clsx(
            'flex h-[26px] items-center gap-1.5 rounded px-2.5 text-[11.5px] font-medium transition-colors',
            value === key
              ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100',
          )}
        >
          {Icon && <Icon size={12} strokeWidth={1.6} />}
          {label}
          {count !== undefined && (
            <span className="tabular-nums text-[10.5px] text-zinc-400">{count}</span>
          )}
        </button>
      ))}
    </div>
  )
}

// Filtro em lista, para dimensões que não cabem em chips — o número de
// conexões de origem cresce com o tempo e sete chips já quebram a linha.
// Mesma altura e moldura dos chips, para ler como parte da mesma barra.
export function FilterSelect<T extends string>({ icon: Icon, label, value, onChange, options }: {
  icon?: LucideIcon
  label: string
  value: T
  onChange: (v: T) => void
  options: { key: T; label: string; count?: number }[]
}) {
  return (
    <label className="flex h-[30px] items-center gap-1.5 rounded-lg border border-zinc-200 bg-white pl-2.5 text-[11.5px] dark:border-zinc-800 dark:bg-zinc-900">
      {Icon && <Icon size={12} strokeWidth={1.6} className="text-zinc-400" />}
      <span className="text-zinc-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-[28px] max-w-[210px] cursor-pointer rounded-lg border-0 bg-transparent pr-1.5 text-[11.5px] font-medium outline-none"
      >
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}{o.count !== undefined ? ` (${o.count})` : ''}
          </option>
        ))}
      </select>
    </label>
  )
}

export function PrimaryButton({ icon: Icon, children, ...rest }: React.ComponentProps<'button'> & { icon?: LucideIcon }) {
  return (
    <button
      {...rest}
      className="flex h-[30px] items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-semibold text-zinc-950 transition-colors hover:bg-accent-hover active:scale-95 disabled:opacity-60"
    >
      {Icon && <Icon size={14} strokeWidth={2} />}
      {children}
    </button>
  )
}

export function EmptyState({ icon: Icon, message, action }: {
  icon: LucideIcon; message: string; action?: React.ReactNode
}) {
  return (
    <div className="px-3 py-10 text-center">
      <Icon size={26} strokeWidth={1.2} className="mx-auto mb-2 text-zinc-300 dark:text-zinc-700" />
      <p className="mx-auto max-w-[52ch] text-[12px] leading-relaxed text-zinc-500">{message}</p>
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  )
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="mb-2.5 flex items-start gap-2.5 rounded-2xl border border-crit/40 bg-crit-soft p-3 dark:bg-crit/10">
      <p className="flex-1 text-[12px] leading-relaxed text-crit dark:text-crit-dark">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="shrink-0 text-[11.5px] font-medium text-info hover:underline dark:text-info-dark">
          Tentar de novo
        </button>
      )}
    </div>
  )
}

export function TableSkeleton() {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="h-[76px] animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
      <div className="h-[260px] animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
    </div>
  )
}
