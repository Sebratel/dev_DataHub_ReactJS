// Pastas das migrations, sem efeito colateral (o pool.ts abre o banco ao ser
// importado; o copiador e os smokes só precisam saber onde estão os arquivos).
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/** Migrations do Postgres (a fonte da verdade dos nomes). */
export const MIGRATIONS_DIR = resolve(here, 'migrations')
/** Mesmas migrations, em MariaDB (mesmos nomes; 000-base.sql cobre 001…043). */
export const MARIA_MIGRATIONS_DIR = resolve(here, 'migrations-mariadb')
