// Operar › Regras de atualização — um módulo só para "como cada conjunto
// atualiza" (pedido de 26/11/2026). Eram duas entradas no menu falando do
// mesmo assunto:
//   Regras      a regra em vigor de cada conjunto e os agendamentos;
//   Padronizar  a proposta de regra incremental lida do catálogo da origem.
// O endereço antigo /admin/autotune cai na aba Padronizar.
import { ListChecks, Wand2 } from 'lucide-react'
import { ModulePage } from '@/components/ui/Page'
import SyncRulesPage from './SyncRulesPage'
import AutotunePage from './AutotunePage'

export default function UpdateRulesModule() {
  return (
    <ModulePage
      icon={ListChecks}
      title="Regras de atualização"
      subtitle="Como cada conjunto atualiza, os agendamentos e a proposta de regra incremental lida da origem."
      tabs={[
        { key: 'regras', label: 'Regras e agendamentos', icon: ListChecks, render: () => <SyncRulesPage /> },
        { key: 'padronizar', label: 'Padronizar', icon: Wand2, render: () => <AutotunePage /> },
      ]}
    />
  )
}
