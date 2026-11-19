// libSQL pelo `@libsql/client` (dependência opcional de quem usa este driver).
import type { Client, InStatement, InValue, ResultSet } from '@libsql/client'
import type { Driver, Row, ScratchDriver, Statement } from '../core/types'
import { sqlite } from '../dialects/sqlite'

/** O que o driver usa do `@libsql/client` (nativo ou `/web`). */
export type LibsqlClient = Pick<Client, 'execute' | 'batch' | 'migrate'>

function toStatement(statement: Statement): InStatement {
  return { sql: statement.sql, args: [...(statement.args ?? [])] as InValue[] }
}

function toRows(result: ResultSet): Row[] {
  return result.rows.map((row) => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])))
}

export interface LibsqlDriverOptions {
  /**
   * Banco descartável. Padrão: arquivo SQLite temporário aberto pelo
   * `@libsql/client` nativo (ferramentas, não Workers).
   */
  scratch?: () => Promise<ScratchDriver>
}

async function temporaryFile(): Promise<ScratchDriver> {
  const [{ createClient }, { rmSync }, { tmpdir }, { join }] = await Promise.all([
    import('@libsql/client'),
    import('node:fs'),
    import('node:os'),
    import('node:path'),
  ])
  const path = join(tmpdir(), `migrator-scratch-${crypto.randomUUID()}.db`)
  const client = createClient({ url: `file:${path}`, intMode: 'number' })
  return {
    ...libsql(client),
    async dispose() {
      client.close()
      for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${path}${suffix}`, { force: true })
    },
  }
}

/**
 * libSQL: Turso Cloud, `sqld` local ou arquivo SQLite. Transação sem chaves
 * estrangeiras usa `client.migrate()`, que as desliga só naquele pedido.
 */
export function libsql(client: LibsqlClient, options: LibsqlDriverOptions = {}): Driver {
  return {
    dialect: sqlite(),
    async query(statement) {
      return toRows(await client.execute(toStatement(statement)))
    },
    async run(statement) {
      return { changes: (await client.execute(toStatement(statement))).rowsAffected }
    },
    async transaction(statements, { foreignKeys }) {
      const items = statements.map(toStatement)
      if (foreignKeys) await client.batch(items, 'write')
      else await client.migrate(items)
    },
    scratch: options.scratch ?? temporaryFile,
  }
}
