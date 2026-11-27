// Operar › Assistente IA — o provedor que responde e a avaliação do que ele
// responde (27/11/2026). Trocar de modelo e medir o efeito ficam lado a lado:
// é a mesma decisão.
import { Sparkle, ClipboardCheck } from 'lucide-react'
import { ModulePage } from '@/components/ui/Page'
import AiProvidersPage from './AiProvidersPage'
import AiEvalPage from './AiEvalPage'

export default function AiModule() {
  return (
    <ModulePage
      icon={Sparkle}
      title="Assistente IA"
      subtitle="Qual modelo responde e quantas perguntas de negócio ele acerta."
      tabs={[
        { key: 'provedores', label: 'Provedores', icon: Sparkle, render: () => <AiProvidersPage /> },
        { key: 'avaliacao', label: 'Avaliação', icon: ClipboardCheck, render: () => <AiEvalPage /> },
      ]}
    />
  )
}
