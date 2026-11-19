# Changelog

As versões seguem [RELEASING.md](RELEASING.md). Mudança de quebra é permitida no beta e sempre aparece em "Mudanças de quebra".

## 0.1.1-beta (19/11/2026)

### Segurança

- `bunfig.toml` com `install.auto = "disable"`: o Bun nunca instala pacote sozinho neste repositório.

### Mudanças de quebra

- O pacote agora se chama `@mvcc-kit/migrator` (o nome `migrator` existe no npm e é de outra pessoa; fora do projeto, o Bun o baixaria e rodaria). Troque a dependência para `"@mvcc-kit/migrator": "github:mvcc-kit/migrator#v0.1.1-beta"` e os imports de `'migrator'` e `'migrator/...'` para `'@mvcc-kit/migrator'` e `'@mvcc-kit/migrator/...'`.

## 0.1.0-beta (19/11/2026)

### Adicionado

- `createMigrator` com `init`, `status`, `migrate`, `adopt` e `unlock`: checksum, hash encadeado, trava, identidade do ambiente, promoção entre ambientes, detecção de drift e lint de comandos destrutivos.
- Layouts `sqlFolder` (pasta de `.sql` numerados), `drizzleKitJournal` (drizzle-kit 0.31) e `inlineLayout` (lista no código, para Workers e bundlers).
- Drivers `http` (Turso Cloud e `sqld` pelo Hrana v2, só `fetch`), `libsql` (`@libsql/client`), `bunSqlite` (com `memoryScratch`) e `d1`.
- Dialeto `sqlite` (SQLite, libSQL, Turso e Cloudflare D1).
- `splitStatements` e `stripSql`: leitura de SQL que respeita strings, comentários e o corpo de triggers.
- `SKILL.md` e `llms.txt` para agentes de IA, com exemplos que rodam no teste.
- `bun run leak-check`: procura dados privados nos arquivos, no histórico do Git e nos autores, também dentro do `release`.

### Segurança

- A trava é tomada antes de ler o histórico: duas execuções nunca aplicam a mesma lista.
- O lint lê o SQL sem comentários e sem strings: um comentário antes do `DROP TABLE` ou um `WITH ... DELETE` não escondem o comando destrutivo.
- Falha ao devolver a trava não esconde o erro da migration e mostra o dono para o `unlock`.
- No driver HTTP, o `PRAGMA foreign_keys = OFF` e a transação vão no mesmo lote: se o PRAGMA falhar, nada roda com as chaves estrangeiras ligadas.
