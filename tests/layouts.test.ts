import { afterEach, describe, expect, it } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkOrder, inlineLayout, statementsOf } from '../src'
import { drizzleKitJournal } from '../src/layouts/drizzle-kit'
import { sqlFolder } from '../src/layouts/sql-folder'
import { breakpoints, cleanup, drizzleFolder, sqlDir, tempDir } from './helpers'

afterEach(cleanup)

describe('sqlFolder', () => {
  it('ordena pelo número, avisa arquivo fora do padrão e bloqueia número repetido', async () => {
    const dir = sqlDir({
      '10_ten': 'SELECT 10',
      '0002_two': 'SELECT 2',
      '1_one': 'SELECT 1',
      notes: 'SELECT 0',
    })
    writeFileSync(join(dir, 'README.md'), 'ignorado sem aviso')
    const ok = await sqlFolder({ dir }).load()
    expect(ok.migrations.map((m) => m.name)).toEqual(['1_one', '0002_two', '10_ten'])
    expect(ok.warnings).toEqual(['o arquivo notes.sql não segue <número>_<nome>.sql e ficou de fora'])
    expect(ok.problems).toEqual([])

    const clash = await sqlFolder({ dir: sqlDir({ '0001_a': 'SELECT 1', '1_b': 'SELECT 2' }) }).load()
    expect(clash.problems.join()).toContain('usam o mesmo número')
  })

  it('pasta que não existe vira problema, não exceção', async () => {
    const result = await sqlFolder({ dir: join(tempDir(), 'nao-existe') }).load()
    expect(result.problems.join()).toContain('não consegui ler a pasta')
  })

  it('arquivo com breakpoint do drizzle separa só por ele', () => {
    expect(statementsOf(breakpoints('CREATE TABLE a (x TEXT);', 'CREATE TABLE b (x TEXT);'))).toEqual([
      'CREATE TABLE a (x TEXT);',
      'CREATE TABLE b (x TEXT);',
    ])
  })
})

describe('drizzleKitJournal', () => {
  it('lê o journal, acusa idx fora de sequência, repetido e arquivo faltando', async () => {
    const dir = drizzleFolder({ '0000_a': 'SELECT 1' })
    writeFileSync(
      join(dir, 'meta', '_journal.json'),
      JSON.stringify({
        entries: [
          { idx: 0, tag: '0000_a' },
          { idx: 2, tag: '0000_a' },
          { idx: 3, tag: '0003_missing' },
        ],
      }),
    )
    const result = await drizzleKitJournal({ out: dir }).load()
    expect(result.problems).toEqual([
      'idx 2 do journal fora de sequência (esperado 1)',
      'o journal lista 0000_a duas vezes',
      'idx 3 do journal fora de sequência (esperado 2)',
      'arquivo 0003_missing.sql faltando (está no journal)',
    ])
  })

  it('journal inválido ou ausente vira problema', async () => {
    const dir = drizzleFolder({})
    writeFileSync(join(dir, 'meta', '_journal.json'), '{"nada": 1}')
    expect((await drizzleKitJournal({ out: dir }).load()).problems.join()).toContain('lista "entries" válida')
    expect((await drizzleKitJournal({ out: tempDir() }).load()).problems.join()).toContain('não consegui ler')
  })
})

describe('inlineLayout e checkOrder', () => {
  it('confere nome, repetição e ordem', async () => {
    expect(checkOrder(['0001_a', '0002_b'])).toEqual([])
    expect(checkOrder(['0001_a', '0001_a'])).toEqual(['migration 0001_a aparece duas vezes', '0001_a e 0001_a usam o mesmo número'])
    expect(checkOrder(['init'])).toEqual(['nome inválido "init": use número, "_" e um nome (ex.: 0001_create_users)'])
    expect(checkOrder(['0002_b', '0001_a'])).toEqual(['0001_a está fora da ordem numérica'])
    const result = await inlineLayout([{ name: '0001_a', sql: 'SELECT 1; SELECT 2' }]).load()
    expect(result.migrations[0]!.statements).toEqual(['SELECT 1', 'SELECT 2'])
  })
})
