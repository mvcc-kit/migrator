import { describe, expect, it } from 'bun:test'
import { canonicalContent, checksumOf, diffSchemas, hasMultipleStatements, scanSql, schemaHash, splitStatements, stripSql } from '../src'
import { lint } from '../src/dialects/sqlite'

describe('splitStatements', () => {
  it('separa nos ; de nível superior e ignora os de strings, identificadores e comentários', () => {
    const sql = `-- cabeçalho; com ponto e vírgula
CREATE TABLE "a;b" (x TEXT DEFAULT 'um; dois'); /* bloco; */
INSERT INTO [c;d] VALUES ('it''s; ok');
INSERT INTO \`e;f\` VALUES ("g;h")`
    expect(splitStatements(sql)).toEqual([
      `-- cabeçalho; com ponto e vírgula
CREATE TABLE "a;b" (x TEXT DEFAULT 'um; dois')`,
      `/* bloco; */
INSERT INTO [c;d] VALUES ('it''s; ok')`,
      'INSERT INTO `e;f` VALUES ("g;h")',
    ])
  })

  it('mantém o corpo inteiro de um trigger, com CASE ... END dentro', () => {
    const sql = `CREATE TEMP TRIGGER t AFTER INSERT ON x BEGIN
  UPDATE x SET y = CASE WHEN new.a THEN 'end;' ELSE CASE WHEN 1 THEN 2 END END;
  DELETE FROM z WHERE id = new.id;
END;
SELECT 1;`
    const parts = splitStatements(sql)
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEndWith('END')
    expect(parts[1]).toBe('SELECT 1')
  })

  it('descarta trechos só de comentário e espaço', () => {
    expect(splitStatements('-- nada\n;  /* x */ ;\n')).toEqual([])
    expect(splitStatements('SELECT 1;;')).toEqual(['SELECT 1'])
    expect(hasMultipleStatements('SELECT 1; -- fim')).toBe(false)
    expect(hasMultipleStatements('SELECT 1; SELECT 2')).toBe(true)
  })

  it('aspas sem fechamento vão até o fim, sem travar', () => {
    expect(splitStatements("SELECT 'aberta; sem fim")).toEqual(["SELECT 'aberta; sem fim"])
    expect(scanSql('/* sem fim').firstKeyword).toBe('')
  })
})

describe('stripSql', () => {
  it('tira comentários, esvazia strings e identificadores e põe em maiúsculas', () => {
    expect(stripSql(`-- DROP TABLE x\nselect 'where' , "where" from t /* where */`)).toBe(`SELECT '' , "_" FROM T`)
  })
})

describe('lint (sqlite)', () => {
  const destructive = (sql: string) => lint(sql).destructive
  const forbidden = (sql: string) => lint(sql).forbidden

  it('pega destrutivos mesmo com comentário antes ou CTE', () => {
    expect(destructive('-- limpeza\nDROP TABLE users')).toEqual(['DROP TABLE'])
    expect(destructive('/* x */ drop view v')).toEqual(['DROP VIEW'])
    expect(destructive('ALTER TABLE users DROP COLUMN email')).toEqual(['ALTER TABLE ... DROP COLUMN'])
    expect(destructive('ALTER TABLE users RENAME TO people')).toEqual(['ALTER TABLE ... RENAME'])
    expect(destructive('WITH old AS (SELECT id FROM s) DELETE FROM users')).toEqual(['DELETE sem WHERE'])
    expect(destructive('UPDATE users SET name = \'WHERE\'')).toEqual(['UPDATE sem WHERE'])
    expect(destructive("DELETE FROM users -- WHERE id = 1")).toEqual(['DELETE sem WHERE'])
  })

  it('não acusa o que não destrói', () => {
    expect(destructive("DELETE FROM users WHERE created_at < '2020-01-01'")).toEqual([])
    expect(destructive('UPDATE users SET a = 1 WHERE id = 2')).toEqual([])
    expect(destructive('CREATE TABLE t (updated_at TEXT, x INTEGER REFERENCES p ON UPDATE CASCADE ON DELETE CASCADE)')).toEqual([])
    expect(destructive('CREATE TRIGGER t AFTER INSERT ON a BEGIN DELETE FROM b; END')).toEqual([])
    expect(destructive('DROP INDEX users_email')).toEqual([])
    expect(destructive('CREATE TABLE "drop table" (x TEXT)')).toEqual([])
  })

  it('proíbe PRAGMA, transação, manutenção, vazio e dois comandos', () => {
    expect(forbidden('-- liga\nPRAGMA foreign_keys=ON').join()).toContain('PRAGMA')
    expect(forbidden('BEGIN').join()).toContain('controle de transação')
    expect(forbidden('vacuum').join()).toContain('manutenção')
    expect(forbidden('ATTACH DATABASE x AS y').join()).toContain('ATTACH')
    expect(forbidden('-- só comentário').join()).toContain('vazio')
    expect(forbidden('SELECT 1; SELECT 2').join()).toContain('mais de um comando')
    expect(forbidden("SELECT 'PRAGMA x'")).toEqual([])
  })
})

describe('hashes', () => {
  it('checksum ignora BOM e CRLF, e só isso', async () => {
    expect(canonicalContent('﻿a\r\nb\rc\n')).toBe('a\nb\nc\n')
    expect(await checksumOf('﻿SELECT 1;\r\n')).toBe(await checksumOf('SELECT 1;\n'))
    expect(await checksumOf('SELECT 1;\n')).not.toBe(await checksumOf('SELECT 1; \n'))
  })

  it('impressão do schema não depende da ordem; diff diz o que mudou', async () => {
    const a = { t: { columns: ['a', 'b'], foreignKeys: [], indexes: ['i'], checks: [] } }
    const b = { t: { columns: ['b', 'a'], foreignKeys: [], indexes: ['i'], checks: [] } }
    expect(await schemaHash(a)).toBe(await schemaHash(b))
    expect(diffSchemas(a, { ...b, u: { columns: [], foreignKeys: [], indexes: [], checks: [] } })).toEqual(['tabela inesperada u'])
    expect(diffSchemas(a, { t: { ...a.t, indexes: [] } })).toEqual(['t indexes faltando: i'])
  })
})
