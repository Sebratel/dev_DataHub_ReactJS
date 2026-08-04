// Tabela densa — o cavalo de batalha de uma plataforma de dados.
// Linha de 33px (era ~44), cabeçalho em versalete de 9,5px, números sempre
// `tabular-nums` e alinhados à direita. Rola dentro do próprio contêiner para
// a página nunca rolar na horizontal.
import clsx from 'clsx'

export function DataGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={clsx('w-full border-collapse text-[12px]', className)}>{children}</table>
    </div>
  )
}

export function Th({ right, children, className, ...rest }: React.ComponentProps<'th'> & { right?: boolean }) {
  return (
    <th
      {...rest}
      className={clsx(
        'whitespace-nowrap border-b border-zinc-200 bg-zinc-50 px-2.5 py-1.5',
        'text-[9.5px] font-semibold uppercase tracking-[0.09em] text-zinc-500',
        'dark:border-zinc-800 dark:bg-zinc-800/40',
        right ? 'text-right' : 'text-left',
        className,
      )}
    >
      {children}
    </th>
  )
}

export function Tr({ children, className, ...rest }: React.ComponentProps<'tr'>) {
  return (
    <tr
      {...rest}
      className={clsx(
        'transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40',
        rest.onClick && 'cursor-pointer',
        className,
      )}
    >
      {children}
    </tr>
  )
}

export function Td({ right, mono, muted, children, className, ...rest }: React.ComponentProps<'td'> & {
  right?: boolean; mono?: boolean; muted?: boolean
}) {
  return (
    <td
      {...rest}
      className={clsx(
        'h-[33px] whitespace-nowrap border-b border-zinc-200 px-2.5 align-middle',
        'dark:border-zinc-800',
        right && 'text-right tabular-nums',
        mono && 'font-mono text-[10.5px]',
        muted && 'text-[11.5px] tabular-nums text-zinc-500',
        className,
      )}
    >
      {children}
    </td>
  )
}

// Nome do conjunto + slug técnico — o par que o analista usa para confirmar
// que está olhando a tabela certa.
export function EntityCell({ name, slug, children }: {
  name: string; slug?: string; children?: React.ReactNode
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {children}
      <span className="min-w-0">
        <span className="block truncate text-[12px] font-medium">{name}</span>
        {slug && <span className="block truncate font-mono text-[10px] text-zinc-400">{slug}</span>}
      </span>
    </span>
  )
}

// Barra de proporção inline (uso relativo, cobertura, participação).
// Sempre acompanhada do número — a barra é o relance, o número é a resposta.
export function MiniBar({ pct }: { pct: number }) {
  const w = Math.max(2, Math.min(100, pct))
  return (
    <span className="inline-block h-1 w-[52px] overflow-hidden rounded-full bg-zinc-100 align-middle dark:bg-zinc-800">
      <span className="block h-full rounded-full" style={{ width: `${w}%`, background: 'var(--series-1)' }} />
    </span>
  )
}
