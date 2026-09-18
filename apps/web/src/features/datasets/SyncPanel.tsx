// Painel de sincronização (admin): modo, chaves incrementais, identidade da
// linha, piso, disparo manual e histórico. O sync roda em fila no servidor;
// aqui só configuramos e acompanhamos.
//
// A segunda linha de controles ("atualizar em vez de duplicar") existe porque o
// incremental de uma chave só não dava conta do caso real: tabela com created e
// modified, em que o modified só é preenchido quando houve edição. Escolher
// 'modified' descartava em silêncio toda linha nunca editada (NULL nunca é > que
// nada, em SQL); escolher 'created' nunca trazia edição. Agora são duas chaves,
// uma passada para cada, e a identidade da linha junta as duas pontas.
import { useState } from 'react'
import { Play, Loader2, Square, Fingerprint, Lock } from 'lucide-react'
import type { DatasetDetail } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import RunsHistory, { useSyncRuns } from './RunsHistory'
import DedupeKeysDialog from './DedupeKeysDialog'

const MODE_LABEL: Record<string, string> = {
  live: 'Ao vivo (sem lake — apenas preview admin)',
  snapshot: 'Snapshot (recarrega tudo a cada sync)',
  incremental: 'Incremental (só novidades, por watermark)',
}

const CADENCE_LABEL: Record<string, string> = {
  daily: 'Diária (janela da madrugada)',
  hourly: 'De hora em hora',
  manual: 'Manual (só sob demanda)',
}

export default function SyncPanel({ dataset, onSynced }: { dataset: DatasetDetail; onSynced: () => void }) {
  const [mode, setMode] = useState(dataset.sync?.mode ?? 'live')
  const [incKey, setIncKey] = useState(dataset.sync?.incrementalKey ?? '')
  const [incKey2, setIncKey2] = useState(dataset.sync?.incrementalKey2 ?? '')
  const [cadence, setCadence] = useState(dataset.sync?.cadence ?? 'daily')
  const [since, setSince] = useState(dataset.sync?.since ?? '')
  const [sinceDays, setSinceDays] = useState(dataset.sync?.sinceDays?.toString() ?? '')
  // Piso fixo e piso relativo são o mesmo campo conceitual — a tela escolhe um.
  const [sinceMode, setSinceMode] = useState<'fixed' | 'relative'>(
    dataset.sync?.sinceDays != null ? 'relative' : 'fixed',
  )
  const [dedupe, setDedupe] = useState<string[]>(dataset.sync?.dedupeKeys ?? [])
  const [lag, setLag] = useState((dataset.sync?.watermarkLagMinutes ?? 0).toString())
  const [dialogAberto, setDialogAberto] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { runs, isRunning: runningNow } = useSyncRuns(dataset.id, onSynced)

  async function saveConfig() {
    setBusy(true)
    setError(null)
    try {
      await api(`/api/v1/datasets/${dataset.id}/sync-config`, {
        method: 'PATCH',
        // Cadencia 'schedule' e' controlada pela tela de Agendamentos -- nao
        // reenvia o valor aqui, senao um clique em "Salvar configuracao" por
        // outro motivo (mudar o modo, por exemplo) e recusado pelo backend
        // (que so aceita daily/hourly/manual nesta rota).
        body: JSON.stringify({
          syncMode: mode,
          incrementalKey: incKey || null,
          incrementalKey2: incKey2 || null,
          syncCadence: dataset.sync?.cadence === 'schedule' ? undefined : cadence,
          // Um piso só: o backend recusa os dois preenchidos.
          syncSince: sinceMode === 'fixed' ? (since || null) : null,
          syncSinceDays: sinceMode === 'relative' ? (sinceDays || null) : null,
          dedupeKeys: dedupe,
          watermarkLagMinutes: Number(lag) || 0,
        }),
      })
      onSynced()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar configuração.')
    } finally {
      setBusy(false)
    }
  }

  async function syncNow() {
    setBusy(true)
    setError(null)
    try {
      await api(`/api/v1/datasets/${dataset.id}/sync`, { method: 'POST' })
      // useSyncRuns pega o novo run sozinho no proximo poll (3s) -- nao
      // precisa de um loadRuns() manual aqui.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao iniciar sincronização.')
    } finally {
      setBusy(false)
    }
  }

  async function cancelNow() {
    setBusy(true)
    setError(null)
    try {
      await api(`/api/v1/datasets/${dataset.id}/sync-cancel`, { method: 'POST' })
      // o run passa a 'cancelled' no proximo checkpoint entre lotes; o hook
      // useSyncRuns pega isso sozinho no proximo poll.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao parar a sincronização.')
    } finally {
      setBusy(false)
    }
  }

  // Mudar COMO uma fonte atualiza é do admin master — o servidor recusa de
  // qualquer jeito (403). Aqui a tela desabilita antes do clique e diz o
  // porquê: descobrir a regra só depois de preencher tudo e apertar Salvar é
  // o pior jeito de aprender que não se pode.
  const isMaster = useAuthStore((s) => !!s.user?.master)

  const campos = dataset.fields.filter((f) => !f.hidden)
  const numericOrDateFields = campos.filter((f) => f.type === 'number' || f.type === 'date')
  const rotulo = (key: string) => campos.find((f) => f.key === key)?.label ?? key
  const ctrl = 'rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950'

  return (
    <div className="mt-5 rounded-xl border border-zinc-200 bg-white p-3.5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-400">Sincronização com o lake (admin)</h2>

      {!isMaster && (
        <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
          <Lock size={14} className="mt-0.5 shrink-0 text-zinc-400" />
          <p className="text-xs leading-relaxed text-zinc-500">
            Somente o <strong>administrador master</strong> altera como uma fonte atualiza — modo, chaves,
            identidade da linha e cadência mexem na carga sobre os bancos de produção. Você continua podendo
            <strong> sincronizar agora</strong> e acompanhar o histórico. Conjuntos calculados seguem liberados.
          </p>
        </div>
      )}

      {/* fieldset + display:contents: desabilita TODO controle de configuração
          de uma vez, sem mudar o layout. Marcar campo a campo deixaria um de
          fora na próxima vez que alguém acrescentasse um. */}
      <fieldset disabled={!isMaster} className="contents">
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-zinc-500">Modo</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className={ctrl}>
            {Object.entries(MODE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        {mode === 'incremental' && (
          <label className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">Chave incremental (número ou data crescente)</span>
            <select value={incKey} onChange={(e) => setIncKey(e.target.value)} className={ctrl}>
              <option value="">— escolha —</option>
              {numericOrDateFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
          </label>
        )}
        {mode === 'incremental' && incKey && (
          <div className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">
              Publicar a partir de <span className="text-zinc-400">(opcional — corta a 1ª carga)</span>
            </span>
            <div className="flex items-stretch gap-1">
              <div className="flex overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
                <button
                  type="button"
                  onClick={() => setSinceMode('fixed')}
                  className={`px-2.5 text-xs ${sinceMode === 'fixed' ? 'bg-accent-soft text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100' : 'text-zinc-500'}`}
                >
                  Data fixa
                </button>
                <button
                  type="button"
                  onClick={() => setSinceMode('relative')}
                  className={`border-l border-zinc-200 px-2.5 text-xs dark:border-zinc-700 ${sinceMode === 'relative' ? 'bg-accent-soft text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100' : 'text-zinc-500'}`}
                >
                  Últimos dias
                </button>
              </div>
              {sinceMode === 'fixed' ? (
                <input
                  type={campos.find((f) => f.key === incKey)?.type === 'date' ? 'date' : 'number'}
                  value={since}
                  onChange={(e) => setSince(e.target.value)}
                  placeholder="tudo desde o início"
                  className={ctrl}
                />
              ) : (
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={sinceDays}
                    onChange={(e) => setSinceDays(e.target.value)}
                    placeholder="7"
                    className={`${ctrl} w-24`}
                  />
                  <span className="text-xs text-zinc-500">dias atrás</span>
                </div>
              )}
            </div>
          </div>
        )}
        {mode !== 'live' && dataset.sync?.cadence === 'schedule' && (
          // Cadencia 'schedule' NAO tem opcao no dropdown abaixo -- se ele
          // renderizasse mesmo assim, o <select> ficaria com um valor que
          // nao bate com nenhuma <option>, e salvar sem mexer em nada
          // sobrescreveria silenciosamente o agendamento em lote por engano.
          <p className="max-w-[220px] rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
            Controlado por um agendamento em lote. Gerencie em Administração › Agendamentos.
          </p>
        )}
        {mode !== 'live' && dataset.sync?.cadence !== 'schedule' && (
          <label className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">Cadência (com que frequência sincroniza sozinho)</span>
            <select value={cadence} onChange={(e) => setCadence(e.target.value as typeof cadence)} className={ctrl}>
              {Object.entries(CADENCE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        )}
      </div>

      {mode === 'incremental' && incKey && (
        <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">Atualizar em vez de duplicar</p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="text-sm">
              <span className="mb-1 block text-xs text-zinc-500">Identidade da linha</span>
              <button
                type="button"
                onClick={() => setDialogAberto(true)}
                className={`${ctrl} flex max-w-[260px] items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800`}
              >
                <Fingerprint size={14} className="shrink-0 text-zinc-400" />
                <span className="truncate">
                  {dedupe.length ? dedupe.map(rotulo).join(', ') : '— definir —'}
                </span>
              </button>
            </div>
            <label className="text-sm">
              <span className="mb-1 block text-xs text-zinc-500">2ª chave (ex.: data de edição)</span>
              <select
                value={incKey2}
                onChange={(e) => setIncKey2(e.target.value)}
                disabled={!dedupe.length}
                title={dedupe.length
                  ? 'Uma passada para cada chave: traz o que foi criado E o que foi editado.'
                  : 'Defina a identidade da linha primeiro — sem ela, a linha criada E editada entraria duas vezes no lake.'}
                className={`${ctrl} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <option value="">— nenhuma —</option>
                {numericOrDateFields.filter((f) => f.key !== incKey)
                  .map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs text-zinc-500">Folga de reconferência</span>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={0}
                  max={10080}
                  value={lag}
                  onChange={(e) => setLag(e.target.value)}
                  title="Rebobina o watermark em N minutos a cada sync, para não perder edição que chegue com carimbo retroativo."
                  className={`${ctrl} w-24`}
                />
                <span className="text-xs text-zinc-500">min</span>
              </div>
            </label>
          </div>
          <p className="mt-2.5 max-w-3xl text-xs text-zinc-500">
            {dedupe.length ? (
              <>
                Quando a mesma identidade voltar da fonte, a versão mais recente <strong>substitui</strong> a
                anterior — vale a maior data entre as chaves escolhidas.
              </>
            ) : (
              <>
                Sem identidade, cada sincronização apenas <strong>acrescenta</strong>: uma linha editada passa a
                conviver com a versão antiga dela no lake, e a contagem sobe sozinha.
              </>
            )}
          </p>
        </div>
      )}

      </fieldset>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          onClick={saveConfig}
          // Fora do fieldset porque "Sincronizar agora" e "Parar" são vizinhos
          // dele e continuam valendo para admin — operar não é reconfigurar.
          disabled={!isMaster || busy || (mode === 'incremental' && !incKey)}
          title={isMaster ? undefined : 'Somente o administrador master altera a atualização de uma fonte.'}
          className="rounded-lg border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Salvar configuração
        </button>
        {mode !== 'live' && (
          <button
            onClick={syncNow}
            disabled={busy || runningNow}
            className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-zinc-950 hover:bg-accent-hover disabled:opacity-60"
          >
            {runningNow ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {runningNow ? 'Sincronizando…' : 'Sincronizar agora'}
          </button>
        )}
        {runningNow && (
          <button
            onClick={cancelNow}
            disabled={busy}
            className="flex items-center gap-2 rounded-lg border border-red-300 px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-60 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            <Square size={14} /> Parar
          </button>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}

      {dialogAberto && (
        <DedupeKeysDialog
          fields={campos}
          value={dedupe}
          onClose={() => setDialogAberto(false)}
          onConfirm={(keys) => {
            setDedupe(keys)
            // Tirar a identidade invalida a 2ª chave: o backend recusaria o par,
            // e deixar o <select> preenchido faria o erro aparecer só no Salvar.
            if (!keys.length) setIncKey2('')
          }}
        />
      )}

      <RunsHistory runs={runs} />
    </div>
  )
}
