// Operar › Saúde e qualidade — um módulo só para "tem algo errado que precisa
// de mim?" (pedido de 26/11/2026). Eram duas entradas no menu que repetiam
// as verificações falhando e a conciliação divergente:
//   Saúde da plataforma  problemas abertos, falhas de 24 h, fila, disco, alertas;
//   Qualidade dos dados  conciliação fonte × lake por conjunto e a correção.
// O endereço antigo /admin/quality cai na aba Qualidade; o sino segue em /admin/health.
import { Activity, ClipboardCheck } from 'lucide-react'
import { ModulePage } from '@/components/ui/Page'
import HealthPage from './HealthPage'
import QualityPage from './QualityPage'

export default function HealthModule() {
  return (
    <ModulePage
      icon={Activity}
      title="Saúde e qualidade"
      subtitle="O que precisa de atenção no Data Hub e a conferência dos dados com a fonte."
      tabs={[
        { key: 'saude', label: 'Saúde da plataforma', icon: Activity, render: () => <HealthPage /> },
        { key: 'qualidade', label: 'Qualidade dos dados', icon: ClipboardCheck, render: () => <QualityPage /> },
      ]}
    />
  )
}
