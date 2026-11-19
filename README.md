# migrator

Aplica migrations SQL versionadas com segurança: checksum, hash encadeado, trava, identidade do ambiente, detecção de drift e lint de comandos destrutivos. SQLite, libSQL/Turso e Cloudflare D1. Zero dependência em tempo de execução.

```ts
import { Database } from 'bun:sqlite'
import { createMigrator, inlineLayout } from 'migrator'
import { bunSqlite } from 'migrator/drivers/bun-sqlite'

const migrator = createMigrator({
  driver: bunSqlite(new Database(':memory:')),
  layout: inlineLayout([{ name: '0001_users', sql: 'CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL)' }]),
})
await migrator.init()
await migrator.migrate()
```

## Por que

- **Produção aplica exatamente o que foi revisado.** Editar uma migration já aplicada, apagar, reordenar ou mexer no histórico à mão bloqueia tudo.
- **O banco é o que o histórico diz.** Cada `status()` e cada `migrate()` reaplica o histórico num banco descartável e compara o schema com o real.
- **Nada destrutivo por acidente.** `DROP`, `RENAME` e `DELETE`/`UPDATE` sem `WHERE` precisam de um motivo escrito no arquivo e de uma flag de quem aplica.
- **Uma execução por vez.** Trava em tabela, tomada antes de ler o histórico.
- **O banco certo.** Cada banco guarda o nome do ambiente; o script de produção recusa o banco de preview.
- **Peças trocáveis.** Layout (pasta, drizzle-kit, lista no código), driver (HTTP do Turso, `@libsql/client`, `bun:sqlite`, D1) e dialeto são arquivos separados. O núcleo roda em Bun, Node e Workers.

## Instalar

```json
{ "dependencies": { "migrator": "github:mvcc-kit/migrator#v0.1.0-beta" } }
```

## Documentação

- [`SKILL.md`](SKILL.md): guia completo de uso (também em [`llms.txt`](llms.txt), para agentes de IA).
- [`ADR.md`](ADR.md): decisões e o que ficou de fora.
- [`AGENTS.md`](AGENTS.md): regras para quem mexe na biblioteca.
- [`CHANGELOG.md`](CHANGELOG.md) e [`RELEASING.md`](RELEASING.md): versões.

## Licença

MIT.
