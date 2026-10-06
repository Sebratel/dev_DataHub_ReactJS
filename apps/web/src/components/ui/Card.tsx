// Card e cabeçalho de card — o contêiner de bloco padrão.
// Densidade: cabeçalho de 38px, título em 11,5px semibold (não `text-lg`), e a
// hierarquia vem da BORDA, não da sombra.
import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={clsx(
      'overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-card',
      'dark:border-zinc-800 dark:bg-zinc-900',
      className,
    )}>
      {children}
    </section>
  )
}

export function CardHead({ icon: Icon, title, sub, lead, children, className }: {
  icon?: LucideIcon
  title: string
  sub?: string
  /**
   * Controle à ESQUERDA, antes do ícone. Para o que age sobre o cartão
   * inteiro e não é uma ação da barra de ferramentas — recolher, por exemplo,
   * que todo editor põe junto do título, não no meio dos botões.
   */
  lead?: React.ReactNode
  /** Ações à direita (link, seletor, legenda). */
  children?: React.ReactNode
  className?: string
}) {
  return (
    <header className={clsx(
      'flex h-[38px] items-center gap-2.5 border-b border-zinc-200 px-3 dark:border-zinc-800',
      className,
    )}>
      {lead}
      {Icon && <Icon size={14} strokeWidth={1.5} className="shrink-0 text-zinc-400" />}
      <h2 className="shrink-0 text-[11.5px] font-semibold">{title}</h2>
      {sub && <span className="truncate text-[10.5px] tabular-nums text-zinc-400">{sub}</span>}
      {children && <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>}
    </header>
  )
}

// Link de ação no cabeçalho. Azul, não âmbar: `text-accent` tem ~2,4:1 de
// contraste e não serve para texto (ver comentário no tailwind.config).
export function CardLink({ children, ...rest }: React.ComponentProps<'a'>) {
  return (
    <a {...rest} className="text-[11px] font-medium text-info hover:underline dark:text-info-dark">
      {children}
    </a>
  )
}
