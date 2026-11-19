// Pasta de `.sql` numerados (`0001_create_users.sql`), escritos à mão ou por
// qualquer gerador. A ordem é a do número.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkOrder, MIGRATION_NAME, statementsOf } from '../core/layout'
import type { Layout, LayoutResult } from '../core/types'

export interface SqlFolderOptions {
  /** Pasta com as migrations. */
  dir: string
}

/**
 * Cada arquivo `<número>_<nome>.sql` é uma migration, e o nome dela é o do
 * arquivo sem `.sql`. Ordem pelo número (zeros à esquerda não importam). Número
 * repetido bloqueia; arquivo fora do padrão só gera aviso e fica de fora.
 */
export function sqlFolder(options: SqlFolderOptions): Layout {
  return {
    name: 'sql-folder',
    async load(): Promise<LayoutResult> {
      const result: LayoutResult = { migrations: [], problems: [], warnings: [] }
      let entries: string[]
      try {
        entries = await readdir(options.dir)
      } catch (error) {
        result.problems.push(`não consegui ler a pasta ${options.dir}: ${error instanceof Error ? error.message : String(error)}`)
        return result
      }
      const names: string[] = []
      for (const file of entries.sort()) {
        if (!file.endsWith('.sql')) continue
        const name = file.slice(0, -'.sql'.length)
        if (!MIGRATION_NAME.test(name)) {
          result.warnings.push(`o arquivo ${file} não segue <número>_<nome>.sql e ficou de fora`)
          continue
        }
        names.push(name)
      }
      const number = (name: string) => BigInt(MIGRATION_NAME.exec(name)![1]!)
      names.sort((left, right) => (number(left) < number(right) ? -1 : number(left) > number(right) ? 1 : left.localeCompare(right)))
      result.problems.push(...checkOrder(names))
      for (const name of names) {
        const content = await readFile(join(options.dir, `${name}.sql`), 'utf8')
        result.migrations.push({ name, content, statements: statementsOf(content) })
      }
      return result
    },
  }
}
