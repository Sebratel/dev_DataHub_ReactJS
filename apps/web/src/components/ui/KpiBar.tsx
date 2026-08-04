// Barra única de métricas-chave — substitui a fileira de cards soltos.
// Cards separados gastam ~40% da largura em borda e espaço vazio; uma barra
// com separadores de 1px cabe mais informação e lê como instrumento.
//
// Cada célula: rótulo em versalete, valor grande, sparkline à direita, e um
// rodapé com o chip de variação + contexto.
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'
import Sparkline, { type SparkTone } from './Sparkline'
import { Delta } from './Pill'

export interface Kpi {
  label: string
  value: string
  /** Sufixo pequeno colado no valor: "M", "s", "h". */
  unit?: string
  icon?: LucideIcon
  spark?: number[]
  sparkTone?: SparkTone
  delta?: { dir: 'up' | 'down' | 'flat'; text: string; good?: boolean }
  /** Contexto curto à direita do chip de variação. */
  foot?: string
  to?: string
}

function Cell({ kpi }: { kpi: Kpi }) {
  const { icon: Icon } = kpi
  return (
    <>
      <div className="flex items-center gap-1.5">
        {Icon && <Icon size={12} strokeWidth={1.5} className="shrink-0 text-zinc-400" />}
        <span className="truncate text-[9.5px] font-semibold uppercase tracking-[0.09em] text-zinc-500">
          {kpi.label}
        </span>
      </div>

      <div className="flex items-end gap-2">
        <span className="text-[20px] font-semibold leading-none tracking-[-0.028em] tabular-nums">
          {kpi.value}
          {kpi.unit && <small className="ml-px text-[11px] font-normal tracking-normal text-zinc-500">{kpi.unit}</small>}
        </span>
        {kpi.spark && (
          <span className="ml-auto shrink-0">
            <Sparkline values={kpi.spark} tone={kpi.sparkTone} />
          </span>
        )}
      </div>

      {(kpi.delta || kpi.foot) && (
        <div className="flex min-w-0 items-center gap-2 text-[10.5px] tabular-nums text-zinc-500">
          {kpi.delta && <Delta dir={kpi.delta.dir} good={kpi.delta.good}>{kpi.delta.text}</Delta>}
          {kpi.foot && <span className="truncate">{kpi.foot}</span>}
        </div>
      )}
    </>
  )
}

export default function KpiBar({ items }: { items: Kpi[] }) {
  return (
    <div
      className="grid overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-card dark:border-zinc-800 dark:bg-zinc-900"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map((kpi) => {
        const cls = clsx(
          'flex flex-col gap-1.5 border-l border-zinc-200 px-3 py-2.5 text-left transition-colors first:border-l-0',
          'dark:border-zinc-800',
          kpi.to && 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
        )
        return kpi.to
          ? <Link key={kpi.label} to={kpi.to} className={cls}><Cell kpi={kpi} /></Link>
          : <div key={kpi.label} className={cls}><Cell kpi={kpi} /></div>
      })}
    </div>
  )
}
