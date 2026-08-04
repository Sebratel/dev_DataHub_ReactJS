// Camada do lakehouse: Bronze (cópia bruta) → Prata (tratado) → Ouro
// (certificado). Marcador visível na linha do catálogo, na tabela e no painel
// de linhagem — é como o analista sabe se pode confiar no número.
//
// A cor do metal REFORÇA a leitura; quem carrega a informação é o rótulo. Por
// isso `showLabel` é o padrão e o modo só-ponto exige um `title`.
import clsx from 'clsx'

export type Tier = 'bronze' | 'prata' | 'ouro'

export const TIER_LABEL: Record<Tier, string> = {
  bronze: 'Bronze',
  prata: 'Prata',
  ouro: 'Ouro',
}

export const TIER_HINT: Record<Tier, string> = {
  bronze: 'Cópia bruta ingerida da fonte, sem transformação.',
  prata: 'Tratado: deduplicado, tipado e reconciliado.',
  ouro: 'Certificado pelo dono — alimenta painéis, APIs e modelos.',
}

const DOT: Record<Tier, string> = {
  bronze: 'bg-tier-bronze dark:bg-tier-bronze-dark',
  prata: 'bg-tier-prata dark:bg-tier-prata-dark',
  ouro: 'bg-tier-ouro dark:bg-tier-ouro-dark',
}
const TEXT: Record<Tier, string> = {
  bronze: 'text-tier-bronze dark:text-tier-bronze-dark',
  prata: 'text-tier-prata dark:text-tier-prata-dark',
  ouro: 'text-tier-ouro dark:text-tier-ouro-dark',
}

// Deriva a camada a partir do que o catálogo já sabe hoje: fonte = bronze,
// derivado = prata, derivado marcado como oficial = ouro. Quando a coluna
// `tier` existir no banco, troque só esta função.
export function tierOf(kind: string, official?: boolean): Tier {
  if (official) return 'ouro'
  return kind === 'derived' ? 'prata' : 'bronze'
}

export default function TierBadge({ tier, showLabel = true, className }: {
  tier: Tier; showLabel?: boolean; className?: string
}) {
  return (
    <span
      title={showLabel ? TIER_HINT[tier] : `${TIER_LABEL[tier]} — ${TIER_HINT[tier]}`}
      className={clsx(
        'inline-flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider',
        TEXT[tier], className,
      )}
    >
      <span className={clsx('h-[6px] w-[6px] shrink-0 rounded-sm', DOT[tier])} />
      {showLabel && TIER_LABEL[tier]}
    </span>
  )
}
