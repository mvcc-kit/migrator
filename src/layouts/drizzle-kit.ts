// Formato do drizzle-kit 0.31: `<out>/0000_nome.sql` e `<out>/meta/_journal.json`.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scanSql } from '../core/sql-text'
import { STATEMENT_BREAKPOINT } from '../core/layout'
import type { Layout, LayoutResult } from '../core/types'

export { STATEMENT_BREAKPOINT }

export interface DrizzleKitJournalOptions {
  /** A pasta `out` do drizzle.config (onde está `meta/_journal.json`). */
  out: string
}

function isJournal(value: unknown): value is { entries: { idx: number; tag: string }[] } {
  if (typeof value !== 'object' || value === null || !('entries' in value)) return false
  const { entries } = value
  return (
    Array.isArray(entries) &&
    entries.every(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        'idx' in entry &&
        'tag' in entry &&
        typeof entry.idx === 'number' &&
        typeof entry.tag === 'string',
    )
  )
}

/** Comandos só pelas fronteiras geradas; nunca `split(";")`. */
export function splitBreakpoints(content: string): string[] {
  return content
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => scanSql(statement).firstKeyword !== '')
}

/** O journal é a única fonte da ordem. */
export function drizzleKitJournal(options: DrizzleKitJournalOptions): Layout {
  return {
    name: 'drizzle-kit journal',
    async load(): Promise<LayoutResult> {
      const result: LayoutResult = { migrations: [], problems: [], warnings: [] }
      const journalPath = join(options.out, 'meta', '_journal.json')
      let journal: unknown
      try {
        journal = JSON.parse(await readFile(journalPath, 'utf8'))
      } catch (error) {
        result.problems.push(`não consegui ler ${journalPath}: ${error instanceof Error ? error.message : String(error)}`)
        return result
      }
      if (!isJournal(journal)) {
        result.problems.push(`${journalPath} não tem uma lista "entries" válida`)
        return result
      }
      const entries = [...journal.entries].sort((left, right) => left.idx - right.idx)
      const seen = new Set<string>()
      entries.forEach((entry, position) => {
        if (entry.idx !== position) result.problems.push(`idx ${entry.idx} do journal fora de sequência (esperado ${position})`)
        if (seen.has(entry.tag)) result.problems.push(`o journal lista ${entry.tag} duas vezes`)
        seen.add(entry.tag)
      })
      const files = new Set((await readdir(options.out)).filter((name) => name.endsWith('.sql')))
      for (const entry of entries) {
        const fileName = `${entry.tag}.sql`
        if (!files.has(fileName)) {
          result.problems.push(`arquivo ${fileName} faltando (está no journal)`)
          continue
        }
        const content = await readFile(join(options.out, fileName), 'utf8')
        result.migrations.push({ name: entry.tag, content, statements: splitBreakpoints(content) })
      }
      for (const file of [...files].sort())
        if (!seen.has(file.slice(0, -'.sql'.length))) result.warnings.push(`o arquivo ${file} não está no journal e será ignorado`)
      return result
    },
  }
}
