# TAREFAS

O que falta, por ordem de valor. Item novo que a IA sugerir entra como **sugestão** até o dono aprovar (AGENTS.md, regra 11).

## Pendentes

- [ ] Dialeto `postgres` e driver para ele (`postgres.js` ou `pg`), com `pg_advisory_xact_lock` como guarda extra da trava.
- [ ] Layout do drizzle-kit v1 (pasta por migration, sem journal) quando o drizzle-kit v1 sair do beta.

## Sugestões (precisam do dono)

- [ ] `drizzleKitJournal({ dropForeignKeyPragmas: true })`: o drizzle-kit gera `PRAGMA foreign_keys=OFF/ON` em volta da reconstrução de tabela no SQLite, e o lint os proíbe. Hoje é preciso apagar as duas linhas do arquivo gerado.
- [ ] Comando de linha (`bunx migrator status --env ...`) para quem não quer escrever o `scripts/db.ts`.
