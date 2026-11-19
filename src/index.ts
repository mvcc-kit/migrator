// Entrada pública do núcleo. Não importa sistema de arquivos, SDK nem motor:
// roda em Bun, Node e Cloudflare Workers.
export { createMigrator, TOOL_VERSION } from './core/migrator'
export type { AppliedRecord, MigrateOptions, MigrateResult, Migrator, MigratorConfig, StatusReport } from './core/migrator'
export { canonicalContent, chainHash, checksumOf, diffSchemas, schemaHash, sha256 } from './core/hash'
export { hasMultipleStatements, scanSql, splitStatements, stripSql, tokenize } from './core/sql-text'
export type { Token, TokenKind } from './core/sql-text'
export { checkOrder, inlineLayout, MIGRATION_NAME, STATEMENT_BREAKPOINT, statementsOf } from './core/layout'
export type { InlineMigration } from './core/layout'
export {
  MigrationError,
  type Dialect,
  type Driver,
  type Layout,
  type LayoutResult,
  type LintResult,
  type MigrationSource,
  type Row,
  type SchemaShape,
  type ScratchDriver,
  type SqlValue,
  type Statement,
  type TableShape,
  type TechnicalTables,
} from './core/types'
