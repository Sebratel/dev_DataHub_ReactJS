// Pílulas de estado e chips de variação.
// Numa UI densa o estado precisa ter FORMA, não só número: a pílula é lida de
// relance sem o usuário precisar interpretar o valor. Cor de estado é
// reservada (ok/warn/crit/info) e nunca vira cor de série de gráfico.
import clsx from 'clsx'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'

export type Tone = 'neutral' | 'ok' | 'warn' | 'crit' | 'info'

const TONE: Record<Tone, string> = {
  neutral: 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-800/60 dark:text-zinc-300',
  ok: 'border-transparent bg-ok-soft text-ok dark:bg-ok/15 dark:text-ok-dark',
  warn: 'border-transparent bg-warn-soft text-warn dark:bg-warn/15 dark:text-warn-dark',
  crit: 'border-transparent bg-crit-soft text-crit dark:bg-crit/15 dark:text-crit-dark',
  info: 'border-transparent bg-info-soft text-info dark:bg-info/15 dark:text-info-dark',
}

export function Pill({ tone = 'neutral', dot, children, className }: {
  tone?: Tone; dot?: boolean; children: React.ReactNode; className?: string
}) {
  return (
    <span className={clsx(
      'inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-[10.5px] font-medium',
      TONE[tone], className,
    )}>
      {dot && <span className="h-[5px] w-[5px] shrink-0 rounded-full bg-current" />}
      {children}
    </span>
  )
}

// Chip de variação. `dir` é a DIREÇÃO do número; `good` diz se essa direção é
// boa — são coisas diferentes (latência subindo é alta e ruim ao mesmo tempo).
export function Delta({ dir, children, good }: {
  dir: 'up' | 'down' | 'flat'; children: React.ReactNode; good?: boolean
}) {
  const positive = good ?? dir === 'up'
  const Icon = dir === 'up' ? TrendingUp : dir === 'down' ? TrendingDown : Minus
  return (
    <span className={clsx(
      'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-px text-[10.5px] font-semibold tabular-nums',
      dir === 'flat'
        ? 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
        : positive
          ? 'bg-ok-soft text-ok dark:bg-ok/15 dark:text-ok-dark'
          : 'bg-crit-soft text-crit dark:bg-crit/15 dark:text-crit-dark',
    )}>
      <Icon size={11} strokeWidth={2.2} />
      {children}
    </span>
  )
}
