// Peças comuns às abas do Gateway de APIs: chip de método, campo de
// formulário, moldura de diálogo e o tipo de token que a tela usa.
import { useEffect } from 'react'
import { X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export const METHOD_CLS: Record<string, string> = {
  GET: 'bg-info-soft text-info dark:bg-info/15 dark:text-info-dark',
  POST: 'bg-ok-soft text-ok dark:bg-ok/15 dark:text-ok-dark',
  PUT: 'bg-warn-soft text-warn dark:bg-warn/15 dark:text-warn-dark',
  PATCH: 'bg-warn-soft text-warn dark:bg-warn/15 dark:text-warn-dark',
  DELETE: 'bg-crit-soft text-crit dark:bg-crit/15 dark:text-crit-dark',
  HEAD: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
}

export function MethodChip({ m }: { m: string }) {
  return (
    <span className={`rounded px-1.5 py-px font-mono text-[9.5px] font-semibold ${METHOD_CLS[m] ?? METHOD_CLS.HEAD}`}>
      {m}
    </span>
  )
}

/**
 * Rótulo + controle + dica. `group` troca o <label> por <div>: um label com
 * vários botões dentro repassa o clique no texto para o PRIMEIRO botão.
 */
export function Field({ label, hint, group, children }: {
  label: string; hint?: string; group?: boolean; children: React.ReactNode
}) {
  const Tag = group ? 'div' : 'label'
  return (
    <Tag className="flex min-w-0 flex-col gap-1">
      <span className="text-[9.5px] font-semibold uppercase tracking-[0.09em] text-zinc-500">{label}</span>
      {children}
      {hint && <span className="text-[10.5px] leading-snug text-zinc-400">{hint}</span>}
    </Tag>
  )
}

export const INPUT = 'w-full rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-[12px] transition-colors '
  + 'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15 '
  + 'dark:border-zinc-800 dark:bg-zinc-950'

export const ICON_BTN = 'rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 '
  + 'disabled:opacity-40 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
export const ICON_BTN_DANGER = 'rounded-md p-1 text-zinc-400 transition-colors hover:bg-crit-soft hover:text-crit '
  + 'disabled:opacity-40 dark:hover:bg-crit/15 dark:hover:text-crit-dark'

/** Chip marcável (escopo de token, upstreams alcançados). */
export function ToggleChip({ on, onClick, tone = 'accent', mono, children }: {
  on: boolean; onClick: () => void; tone?: 'accent' | 'crit'; mono?: boolean; children: React.ReactNode
}) {
  const onCls = tone === 'crit'
    ? 'border-crit bg-crit-soft text-crit dark:bg-crit/10 dark:text-crit-dark'
    : 'border-accent bg-accent-soft text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
  return (
    <button type="button" onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors ${mono ? 'font-mono text-[10.5px]' : ''} ${on
        ? onCls
        : 'border-zinc-200 text-zinc-500 hover:border-zinc-300 dark:border-zinc-700'}`}>
      {children}
    </button>
  )
}

/** Moldura de diálogo: cabeçalho, corpo rolável e rodapé. Esc fecha. */
export function Dialog({ icon: Icon, title, sub, width = 620, onClose, footer, children }: {
  icon: LucideIcon; title: string; sub?: React.ReactNode; width?: number
  onClose: () => void; footer?: React.ReactNode; children: React.ReactNode
}) {
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        style={{ maxWidth: width }}
        className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-card-lg dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2.5 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
          <Icon size={15} className="shrink-0 text-accent" />
          <div className="min-w-0">
            <h2 className="truncate text-[13px] font-semibold">{title}</h2>
            {sub && <p className="text-[10.5px] leading-snug text-zinc-500">{sub}</p>}
          </div>
          <button onClick={onClose} aria-label="Fechar" className="ml-auto rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800">
            <X size={16} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}

export const BTN_SECONDARY = 'rounded-lg border border-zinc-200 px-3 py-1.5 text-[12px] font-medium text-zinc-600 transition-colors '
  + 'hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'
export const BTN_PRIMARY = 'flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-zinc-950 '
  + 'transition-colors hover:bg-accent-hover disabled:opacity-50'

export interface Credential {
  id: string; name: string; dataset_slugs: string[]; write_slugs?: string[]
  owner_email: string; revoked: boolean
  last_used_at: string | null; expires_at: string | null; created_at: string
  rate_limit_per_min: number | null; quota_per_day: number | null; upstream_slugs: string[] | null
}

export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('pt-BR')
export const isExpired = (c: Credential) => !!c.expires_at && new Date(c.expires_at).getTime() < Date.now()

export function errMsg(e: unknown, fallback = 'Falha.') {
  return e instanceof Error ? e.message : fallback
}
