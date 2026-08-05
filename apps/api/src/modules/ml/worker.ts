// Worker de treino. Só embrulha runTraining: recebe a matriz pela porta do
// worker e devolve o resultado. O ponto de rodar aqui é tirar dezenas de
// segundos de CPU do event loop do Express — sem isto, a API inteira
// (inclusive os health checks) fica sem responder durante o treino.
import { parentPort } from 'node:worker_threads'
import { runTraining, type TrainingInput } from './trainer.js'

parentPort?.on('message', (input: TrainingInput) => {
  try {
    parentPort!.postMessage({ ok: true, result: runTraining(input) })
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: (e as Error).message })
  }
})
