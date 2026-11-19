// O que os layouts têm em comum, e o layout `inline` (sem sistema de arquivos).
import { scanSql, splitStatements } from './sql-text'
import type { Layout, LayoutResult, MigrationSource } from './types'

/** Fronteira que o drizzle-kit escreve entre comandos gerados. */
export const STATEMENT_BREAKPOINT = '--> statement-breakpoint'

/** Nome de migration: começa com número e só tem letras, dígitos, `_` e `-`. */
export const MIGRATION_NAME = /^(\d+)[_-][A-Za-z0-9_-]+$/

/**
 * Comandos de uma migration. Com `--> statement-breakpoint` no arquivo, só essa
 * fronteira separa (o que o drizzle-kit gera); sem ela, os `;` de nível superior.
 */
export function statementsOf(content: string): string[] {
  if (content.includes(STATEMENT_BREAKPOINT)) {
    return content
      .split(STATEMENT_BREAKPOINT)
      .map((statement) => statement.trim())
      .filter((statement) => scanSql(statement).firstKeyword !== '')
  }
  return splitStatements(content)
}

/** Confere nomes repetidos e a ordem numérica. A ordem da lista é a de aplicação. */
export function checkOrder(names: readonly string[]): string[] {
  const problems: string[] = []
  const seenNames = new Set<string>()
  const seenNumbers = new Map<bigint, string>()
  let previous: bigint | null = null
  for (const name of names) {
    if (seenNames.has(name)) problems.push(`migration ${name} aparece duas vezes`)
    seenNames.add(name)
    const match = MIGRATION_NAME.exec(name)
    if (!match) {
      problems.push(`nome inválido "${name}": use número, "_" e um nome (ex.: 0001_create_users)`)
      continue
    }
    const number = BigInt(match[1]!)
    const other = seenNumbers.get(number)
    if (other) problems.push(`${name} e ${other} usam o mesmo número`)
    seenNumbers.set(number, name)
    if (previous !== null && number < previous) problems.push(`${name} está fora da ordem numérica`)
    previous = number
  }
  return problems
}

export interface InlineMigration {
  name: string
  sql: string
}

/**
 * Migrations passadas pelo código, na ordem de aplicação. Serve para Workers e
 * bundlers (`import sql from './0001_init.sql' with { type: 'text' }`), em que
 * não há pasta para ler.
 */
export function inlineLayout(migrations: readonly InlineMigration[]): Layout {
  return {
    name: 'inline',
    async load(): Promise<LayoutResult> {
      const sources: MigrationSource[] = migrations.map((migration) => ({
        name: migration.name,
        content: migration.sql,
        statements: statementsOf(migration.sql),
      }))
      return { migrations: sources, problems: checkOrder(migrations.map((m) => m.name)), warnings: [] }
    },
  }
}
