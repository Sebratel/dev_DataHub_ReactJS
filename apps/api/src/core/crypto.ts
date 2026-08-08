// Criptografia simétrica para SEGREDOS em repouso (senhas de conexão de fonte).
// AES-256-GCM (autenticado): detecta adulteração. A chave deriva de
// CONNECTIONS_SECRET (env) por SHA-256. Formato do blob: iv:tag:ciphertext, em
// base64. A senha em claro só existe em memória ao (de)criptografar — nunca no
// banco, nunca no frontend.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'

function key(): Buffer {
  const secret = process.env.CONNECTIONS_SECRET
  if (!secret) {
    // Mensagem acionável: quem cai aqui está numa tela tentando salvar um
    // segredo, e precisa saber o que fazer — não só o que faltou.
    throw new Error(
      'CONNECTIONS_SECRET ausente. É a chave que cifra segredos em repouso ' +
      '(senhas de conexão, chaves de provedor de IA, credenciais de upstream). ' +
      'Defina uma string longa e aleatória na stack (ex.: openssl rand -base64 48) ' +
      'e faça o redeploy. Guarde-a: trocá-la torna ilegível tudo que já foi cifrado.',
    )
  }
  return createHash('sha256').update(secret).digest() // 32 bytes
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
}

export function decryptSecret(blob: string): string {
  const [ivB, tagB, encB] = blob.split(':')
  if (!ivB || !tagB || !encB) throw new Error('Blob de segredo inválido.')
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(encB, 'base64')), decipher.final()]).toString('utf8')
}

// Há chave configurada? (para a tela avisar em vez de estourar ao salvar.)
export function hasSecret(): boolean {
  return !!process.env.CONNECTIONS_SECRET
}
