# Auditorias de segurança

Relatórios de auditoria do repositório ou de uma área, e revisões diferenciais de branch.

| Origem | Arquivo |
|---|---|
| Skill `appsec-audit` (orquestra `appsec-reviewer`, `tenant-isolation-pentester`, `migration-reviewer` e `lgpd-privacy-reviewer`) | `AAAA-MM-DD-<escopo>.md` |
| Skill `tob-differential-review` (revisão de segurança do diff) | `AAAA-MM-DD-diff-review-<branch>.md` |
| Pentest externo | `AAAA-MM-DD-pentest-<fornecedor>.md` (sem dados pessoais nem segredos) |

## Conteúdo mínimo

- Escopo e versão auditada (`git rev-parse HEAD`).
- Método e ferramentas.
- Tabela de achados:

  | ID | Severidade | Categoria (OWASP, ASVS, LGPD) | Arquivo:linha | Evidência | PoC | Correção | Status |
  |---|---|---|---|---|---|---|---|

- O que foi verificado e está seguro.
- O que **não** foi verificado, e por quê.
- Próximos passos.

## Regras

- Achado sem evidência no código não entra. Na dúvida, use a skill `tob-fp-check` para separar
  verdadeiro de falso positivo.
- Achado explorável vira teste que falha (PoC) antes da correção.
- Não inclua segredo, dado pessoal real nem payload de exploração utilizável contra produção.
- Vulnerabilidade ainda aberta em produção **não** é publicada aqui antes da correção. Use um
  advisory privado ([SECURITY.md](../../../SECURITY.md)).
