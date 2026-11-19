import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMigrator, inlineLayout, type Driver, type Layout, type MigratorConfig } from '../src'
import { drizzleKitJournal } from '../src/layouts/drizzle-kit'
import { sqlFolder } from '../src/layouts/sql-folder'
import { breakpoints, cleanup, d1Engine, drizzleFolder, engines, fakePeople, sqlDir, writeJournal, type Engine } from './helpers'
import pkg from '../package.json'

afterEach(cleanup)

const BASE = {
  '0000_base': breakpoints(
    'CREATE TABLE parent (id TEXT PRIMARY KEY NOT NULL, name TEXT)',
    'CREATE TABLE child (id TEXT PRIMARY KEY NOT NULL, parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE)',
  ),
}

/** Relógio falso: cada chamada avança um segundo a partir de uma data fixa. */
function fakeClock() {
  let tick = 0
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++))
}

const names = (result: { applied: { name: string }[] }) => result.applied.map((item) => item.name)

for (const [engineName, makeEngine] of Object.entries(engines)) {
  describe(`migrator (${engineName})`, () => {
    async function setup(files: Record<string, string> = BASE, config: Partial<MigratorConfig> = {}) {
      const engine = await makeEngine()
      const dir = drizzleFolder(files)
      const migrator = createMigrator({
        driver: engine.driver,
        layout: drizzleKitJournal({ out: dir }),
        identity: 'test',
        commit: 'abc123',
        actor: 'tests',
        now: fakeClock(),
        ...config,
      })
      return { engine, dir, migrator }
    }

    it('aplica as pendentes uma vez e grava um histórico auditado', async () => {
      const { engine, migrator } = await setup()
      await migrator.init()
      await migrator.init() // idempotente
      expect(names(await migrator.migrate())).toEqual(['0000_base'])
      expect(names(await migrator.migrate())).toEqual([])
      const report = await migrator.status()
      expect(report).toMatchObject({ applied: ['0000_base'], pending: [], problems: [], lock: null, identity: 'test' })
      expect(report.history[0]).toMatchObject({ appliedBy: 'tests', appCommit: 'abc123', appliedAt: '2026-01-01T00:00:01.000Z' })
      expect(report.history[0]!.chain).toHaveLength(64)
      expect(await engine.value('SELECT tool_version FROM __migrations')).toBe(pkg.version)
    })

    it('usa outro nome de tabela de histórico e valida o nome', async () => {
      const { engine, migrator } = await setup(BASE, { table: 'app_migrations' })
      await migrator.init()
      await migrator.migrate()
      expect(await engine.value('SELECT count(*) FROM app_migrations')).toBe(1)
      expect(await engine.value('SELECT count(*) FROM app_migrations_lock')).toBe(0)
      await expect(setup(BASE, { table: 'bad; DROP' })).rejects.toThrow('nome de tabela inválido')
      await expect(setup(BASE, { identity: '  ' })).rejects.toThrow('identity vazia')
    })

    it('recusa banco marcado para outro ambiente, sem escrever nele', async () => {
      const { engine, dir, migrator } = await setup()
      await migrator.init()
      const other = createMigrator({ driver: engine.driver, layout: drizzleKitJournal({ out: dir }), identity: 'production' })
      await expect(other.migrate()).rejects.toThrow('banco de outro ambiente')
      await expect(other.init()).rejects.toThrow('marcado como "test"')
      await expect(other.adopt('0000_base')).rejects.toThrow('banco de outro ambiente')
      expect(await engine.value('SELECT count(*) FROM __migrations_lock')).toBe(0)
    })

    it('migrate sem init pede init', async () => {
      const { migrator } = await setup()
      await expect(migrator.migrate()).rejects.toThrow('rode init')
      expect((await migrator.status()).problems.join()).toContain('rode init')
    })

    it('não adota tabelas existentes sem pedido, e adota só quando o schema bate', async () => {
      const { engine, migrator } = await setup()
      await engine.exec('CREATE TABLE parent (id TEXT PRIMARY KEY NOT NULL, name TEXT)')
      await expect(migrator.init()).rejects.toThrow('não vou adotá-lo sem pedido')
      await migrator.init({ adoptExisting: true })
      await expect(migrator.adopt('0000_base')).rejects.toThrow('tabela faltando child')
      await engine.exec(
        'CREATE TABLE child (id TEXT PRIMARY KEY NOT NULL, parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE)',
      )
      await expect(migrator.adopt('0009_nope')).rejects.toThrow('migration desconhecida')
      expect(await migrator.adopt('0000_base')).toEqual({ adopted: ['0000_base'] })
      expect((await migrator.status()).problems).toEqual([])
      await expect(migrator.adopt('0000_base')).rejects.toThrow('histórico vazio')
      expect(await engine.value('SELECT count(*) FROM __migrations_lock')).toBe(0)
    })

    it('bloqueia migration editada, cadeia quebrada e schema diferente', async () => {
      const { engine, dir, migrator } = await setup()
      await migrator.init()
      await migrator.migrate()
      writeFileSync(join(dir, '0000_base.sql'), `${BASE['0000_base']}\n-- editada`)
      await expect(migrator.migrate()).rejects.toThrow('checksum diferente')
      writeFileSync(join(dir, '0000_base.sql'), BASE['0000_base'])
      await engine.exec("UPDATE __migrations SET chain = 'x' WHERE id = 1")
      await expect(migrator.migrate()).rejects.toThrow('cadeia do histórico quebrada')
      const fresh = await setup()
      await fresh.migrator.init()
      await fresh.migrator.migrate()
      await fresh.engine.exec('CREATE INDEX manual_idx ON parent(name)')
      await expect(fresh.migrator.migrate()).rejects.toThrow('schema diferente do histórico')
      // Bloqueado não deixa a trava presa.
      expect(await fresh.engine.value('SELECT count(*) FROM __migrations_lock')).toBe(0)
    })

    it('mesmo arquivo com CRLF (checkout do Windows) não vira migration editada', async () => {
      const { dir, migrator } = await setup()
      await migrator.init()
      await migrator.migrate()
      writeFileSync(join(dir, '0000_base.sql'), `\uFEFF${BASE['0000_base'].replaceAll('\n', '\r\n')}`)
      expect((await migrator.status()).problems).toEqual([])
    })

    it('mostra arquivo faltando, arquivo fora do journal e histórico fora de ordem', async () => {
      const missing = await setup(BASE)
      rmSync(join(missing.dir, '0000_base.sql'))
      await missing.migrator.init()
      expect((await missing.migrator.status()).problems.join()).toContain('arquivo 0000_base.sql faltando')

      const engine = await makeEngine()
      const dir = drizzleFolder({ ...BASE, '0001_extra': 'CREATE TABLE extra (id TEXT)' }, ['0000_base'])
      const migrator = createMigrator({ driver: engine.driver, layout: drizzleKitJournal({ out: dir }) })
      await migrator.init()
      expect((await migrator.status()).warnings).toEqual(['o arquivo 0001_extra.sql não está no journal e será ignorado'])

      const reordered = await setup({ '0000_a': 'CREATE TABLE a (id TEXT)', '0001_b': 'CREATE TABLE b (id TEXT)' })
      await reordered.migrator.init()
      await reordered.migrator.migrate()
      writeJournal(reordered.dir, ['0001_b', '0000_a'])
      expect((await reordered.migrator.status()).problems.join()).toContain('fora da ordem')
    })

    it('reconstrói uma tabela pai com 500 pessoas falsas sem apagar os filhos em cascata', async () => {
      const files = {
        ...BASE,
        '0001_rebuild': `-- migration:destructive reconstrói parent para name NOT NULL\n${breakpoints(
          "CREATE TABLE __new_parent (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL DEFAULT '')",
          "INSERT INTO __new_parent (id, name) SELECT id, coalesce(name, '') FROM parent",
          'DROP TABLE parent',
          'ALTER TABLE __new_parent RENAME TO parent',
        )}`,
      }
      const { engine, dir, migrator } = await setup(files)
      writeJournal(dir, ['0000_base'])
      await migrator.init()
      await migrator.migrate()
      const people = fakePeople(500)
      for (const person of people) {
        await engine.exec('INSERT INTO parent VALUES (?, ?)', [person.id, person.note === null ? null : person.name])
        await engine.exec('INSERT INTO child VALUES (?, ?)', [`c-${person.id}`, person.id])
      }
      writeJournal(dir, ['0000_base', '0001_rebuild'])
      await expect(migrator.migrate()).rejects.toThrow('destrutiva')
      expect(names(await migrator.migrate({ allowDestructive: true }))).toEqual(['0001_rebuild'])
      expect(await engine.value('SELECT count(*) FROM child')).toBe(500)
      expect(await engine.value('SELECT count(*) FROM parent')).toBe(500)
      expect(await engine.value("SELECT count(*) FROM parent WHERE name = ''")).toBe(people.filter((p) => p.note === null).length)
      if (engine.foreignKeysOn) expect(await engine.foreignKeysOn()).toBe(1)
    })

    it('desfaz migration que deixaria órfãos ou que falha no meio', async () => {
      const { engine, migrator } = await setup()
      await migrator.init()
      await migrator.migrate()
      await engine.exec("INSERT INTO parent VALUES ('p', 'x')")
      await engine.exec("INSERT INTO child VALUES ('c', 'p')")
      const withExtra = (extra: Record<string, string>) =>
        createMigrator({ driver: engine.driver, layout: drizzleKitJournal({ out: drizzleFolder({ ...BASE, ...extra }) }), identity: 'test' })
      await expect(
        withExtra({ '0001_orphan': breakpoints('CREATE TABLE marker (id TEXT)', "DELETE FROM parent WHERE id = 'p'") }).migrate(),
      ).rejects.toThrow('nada foi aplicado')
      await expect(
        withExtra({ '0001_broken': breakpoints('CREATE TABLE marker (id TEXT)', 'INSERT INTO missing VALUES (1)') }).migrate(),
      ).rejects.toThrow('0001_broken')
      expect(await engine.value("SELECT count(*) FROM sqlite_schema WHERE name = 'marker'")).toBe(0)
      expect(await engine.value('SELECT count(*) FROM child')).toBe(1)
      expect((await migrator.status()).lock).toBeNull()
    })

    it('respeita uma trava existente e só o dono a libera', async () => {
      const { engine, migrator } = await setup()
      await migrator.init()
      await engine.exec("INSERT INTO __migrations_lock (id, owner, acquired_at) VALUES (1, 'outra-execucao', 'agora')")
      await expect(migrator.migrate()).rejects.toThrow('trava ocupada por outra-execucao')
      await expect(migrator.unlock('alguem')).rejects.toThrow('não existe trava')
      await migrator.unlock('outra-execucao')
      expect(names(await migrator.migrate())).toEqual(['0000_base'])
    })

    it('duas execuções ao mesmo tempo aplicam cada migration uma vez só', async () => {
      const files = { ...BASE, '0001_a': 'CREATE TABLE a (id TEXT)', '0002_b': 'CREATE TABLE b (id TEXT)' }
      const { engine, dir, migrator } = await setup(files)
      await migrator.init()
      const twin = createMigrator({ driver: engine.driver, layout: drizzleKitJournal({ out: dir }), identity: 'test' })
      const results = await Promise.allSettled([migrator.migrate(), twin.migrate()])
      const applied = results.flatMap((result) => (result.status === 'fulfilled' ? names(result.value) : []))
      expect(applied.sort()).toEqual(['0000_base', '0001_a', '0002_b'])
      for (const result of results) if (result.status === 'rejected') expect(String(result.reason)).toContain('trava ocupada')
      expect(await engine.value('SELECT count(*) FROM __migrations')).toBe(3)
      expect(await engine.value('SELECT count(*) FROM __migrations_lock')).toBe(0)
    })

    it('quem toma a trava depois que outro terminou lê o histórico de novo e não reaplica', async () => {
      const { engine, dir, migrator } = await setup()
      await migrator.init()
      // A segunda execução começa antes, mas só consegue a trava quando a primeira acabou:
      // a ordem que, com a leitura do histórico antes da trava, reaplicaria a migration.
      let firstDone!: () => void
      const firstFinished = new Promise<void>((resolve) => (firstDone = resolve))
      let reachedLock!: () => void
      const secondAtLock = new Promise<void>((resolve) => (reachedLock = resolve))
      const late: Driver = {
        ...engine.driver,
        async run(statement) {
          if (statement.sql.startsWith('INSERT INTO "__migrations_lock"')) {
            reachedLock()
            await firstFinished
          }
          return engine.driver.run(statement)
        },
      }
      const second = createMigrator({ driver: late, layout: drizzleKitJournal({ out: dir }), identity: 'test' }).migrate()
      await secondAtLock
      expect(names(await migrator.migrate())).toEqual(['0000_base'])
      firstDone()
      expect(names(await second)).toEqual([])
      expect(await engine.value('SELECT count(*) FROM __migrations')).toBe(1)
    })

    it('recusa comandos proibidos, destrutivos escondidos e migrations não promovidas', async () => {
      const bad = await setup({ '0000_bad': 'PRAGMA foreign_keys=OFF' })
      await bad.migrator.init()
      await expect(bad.migrator.migrate()).rejects.toThrow('PRAGMA')
      const twoInOne = await setup({ '0000_two': 'CREATE TABLE a (id TEXT); CREATE TABLE b (id TEXT)' })
      await twoInOne.migrator.init()
      await expect(twoInOne.migrator.migrate()).rejects.toThrow('mais de um comando')
      // Um comentário antes do DROP não esconde o comando destrutivo.
      const hidden = await setup({ ...BASE, '0001_hidden': '-- limpeza\nDROP TABLE child' })
      await hidden.migrator.init()
      await expect(hidden.migrator.migrate({ allowDestructive: true })).rejects.toThrow('DROP TABLE')
      const production = await setup(BASE, { identity: 'production' })
      await production.migrator.init()
      await expect(production.migrator.migrate({ promotion: { from: 'preview', applied: [] } })).rejects.toThrow('ainda não foi aplicada em preview')
      expect(names(await production.migrator.migrate({ promotion: { from: 'preview', applied: ['0000_base'] } }))).toEqual(['0000_base'])
    })

    it('ignora tabelas legadas configuradas na comparação do schema', async () => {
      const { engine, migrator } = await setup(BASE, { ignoreTables: ['_schema_*', 'legacy'] })
      await migrator.init()
      await migrator.migrate()
      await engine.exec('CREATE TABLE _schema_migrations (name TEXT)')
      await engine.exec('CREATE TABLE legacy (name TEXT)')
      expect((await migrator.status()).problems).toEqual([])
    })

    it('pasta de .sql: separa por ; com strings, comentários e triggers', async () => {
      const engine = await makeEngine()
      const dir = sqlDir({
        '0001_people': `-- pessoas (texto com ; e 'aspas')
CREATE TABLE people (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE, -- único
  note TEXT,
  updated INTEGER NOT NULL DEFAULT 0
);
/* bloco; com ponto e vírgula */
CREATE TABLE audit (person_id TEXT NOT NULL, kind TEXT NOT NULL);
CREATE TRIGGER people_audit AFTER UPDATE ON people BEGIN
  INSERT INTO audit VALUES (new.id, CASE WHEN new.note IS NULL THEN 'sem nota; vazio' ELSE 'nota' END);
  UPDATE people SET updated = updated + 1 WHERE id = new.id AND updated = 0;
END;
INSERT INTO people (id, email, note) VALUES ('seed', 'seed@example.test', 'um; dois');
`,
      })
      const migrator = createMigrator({ driver: engine.driver, layout: sqlFolder({ dir }), now: fakeClock() })
      await migrator.init()
      expect(names(await migrator.migrate())).toEqual(['0001_people'])
      for (const person of fakePeople(50, 7)) await engine.exec('INSERT INTO people (id, email, note) VALUES (?, ?, ?)', [person.id, person.email, person.note])
      await engine.exec("UPDATE people SET note = 'x' WHERE id = 'seed'")
      expect(await engine.value('SELECT count(*) FROM people')).toBe(51)
      expect(await engine.value("SELECT kind FROM audit WHERE person_id = 'seed'")).toBe('nota')
      expect(await engine.value("SELECT note FROM people WHERE id = 'p00000'")).toBe(fakePeople(1, 7)[0]!.note)
    })

    it('driver que falha depois do commit: o histórico decide e nada é reaplicado', async () => {
      const engine = await makeEngine()
      const flaky: Driver = {
        ...engine.driver,
        async transaction(statements, options) {
          await engine.driver.transaction(statements, options)
          if (statements.some((statement) => statement.sql.startsWith('INSERT INTO "__migrations"'))) throw new Error('conexão caiu')
        },
      }
      const migrator = createMigrator({ driver: flaky, layout: drizzleKitJournal({ out: drizzleFolder(BASE) }) })
      await migrator.init()
      expect(names(await migrator.migrate())).toEqual(['0000_base'])
      expect(await engine.value('SELECT count(*) FROM __migrations')).toBe(1)
    })

    it('trava que não volta: o erro diz o dono para o unlock', async () => {
      const engine = await makeEngine()
      let failRelease = true
      const sticky: Driver = {
        ...engine.driver,
        async run(statement) {
          if (failRelease && statement.sql.startsWith('DELETE FROM "__migrations_lock"')) {
            failRelease = false
            throw new Error('rede caiu')
          }
          return engine.driver.run(statement)
        },
      }
      const migrator = createMigrator({ driver: sticky, layout: drizzleKitJournal({ out: drizzleFolder(BASE) }) })
      await migrator.init()
      await expect(migrator.migrate({ owner: 'ci-1' })).rejects.toThrow('rode unlock("ci-1")')
      expect((await migrator.status()).lock?.owner).toBe('ci-1')
      await migrator.unlock('ci-1')
      expect((await migrator.status()).applied).toEqual(['0000_base'])
    })
  })
}

describe('migrator (layout inline e D1)', () => {
  it('layout inline: migrations vindas do código', async () => {
    const engine: Engine = await engines['bun-sqlite']!()
    const layout: Layout = inlineLayout([
      { name: '0001_users', sql: 'CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL)' },
      { name: '0002_index', sql: 'CREATE UNIQUE INDEX users_email ON users (email);' },
    ])
    const migrator = createMigrator({ driver: engine.driver, layout })
    await migrator.init()
    expect(names(await migrator.migrate())).toEqual(['0001_users', '0002_index'])
    const broken = createMigrator({
      driver: engine.driver,
      layout: inlineLayout([
        { name: '0002_b', sql: 'SELECT 1' },
        { name: '0001_a', sql: 'SELECT 1' },
      ]),
    })
    expect((await broken.status()).problems.join()).toContain('fora da ordem numérica')
  })

  it('D1: aplica em banco sem FK e recusa banco com FK', async () => {
    const engine = await d1Engine()
    const plain = createMigrator({ driver: engine.driver, layout: inlineLayout([{ name: '0001_a', sql: 'CREATE TABLE a (id TEXT)' }]) })
    await plain.init()
    expect(names(await plain.migrate())).toEqual(['0001_a'])
    // A primeira roda num banco ainda sem FK; a seguinte já encontra a FK e é recusada.
    const withFk = await d1Engine()
    const first = { name: '0001_base', sql: BASE['0000_base'] }
    await createMigrator({ driver: withFk.driver, layout: inlineLayout([first]) }).init()
    expect(names(await createMigrator({ driver: withFk.driver, layout: inlineLayout([first]) }).migrate())).toEqual(['0001_base'])
    const next = createMigrator({ driver: withFk.driver, layout: inlineLayout([first, { name: '0002_x', sql: 'CREATE TABLE x (id TEXT)' }]) })
    await expect(next.migrate()).rejects.toThrow('chave estrangeira')
    expect(await withFk.value('SELECT count(*) FROM __migrations')).toBe(1)
  })

  it('driver sem banco descartável: erro claro, com a correção', async () => {
    const engine = await engines['bun-sqlite']!()
    const { scratch: _, ...withoutScratch } = engine.driver
    const migrator = createMigrator({ driver: withoutScratch, layout: inlineLayout([{ name: '0001_a', sql: 'CREATE TABLE a (id TEXT)' }]) })
    await migrator.init()
    await expect(migrator.status()).rejects.toThrow('passe scratch na configuração')
  })
})
