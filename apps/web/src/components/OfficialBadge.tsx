// Selo "Oficial" — conjunto chancelado pela diretoria como fonte de verdade.
// Usa o gradiente da marca (âmbar) para leitura premium/endossada.
import { BadgeCheck } from 'lucide-react'
import clsx from 'clsx'

export default function OfficialBadge({ size = 'sm', className }: { size?: 'sm' | 'md'; className?: string }) {
  return (
    <span
      title="Relatório oficial — chancelado pela diretoria como fonte de verdade"
      className={clsx(
        'inline-flex shrink-0 items-center gap-1 rounded-full bg-gradient-brand font-semibold text-[#1a1a1a] shadow-card',
        size === 'sm' ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs',
        className,
      )}
    >
      <BadgeCheck size={size === 'sm' ? 12 : 14} strokeWidth={2.5} />
      Oficial
    </span>
  )
}
