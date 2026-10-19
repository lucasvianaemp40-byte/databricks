#!/usr/bin/env bash
# Executa um comando com um PostgreSQL de teste disponível em TEST_DATABASE_URL.
#
#   scripts/with-local-postgres.sh <comando> [args...]
#
# - Se TEST_DATABASE_URL já estiver definida (CI com serviço postgres, banco próprio),
#   apenas executa o comando.
# - Senão, cria um cluster EFÊMERO com os binários locais do PostgreSQL 16 ou mais novo,
#   escutando só em 127.0.0.1 numa porta livre, com senha aleatória (scram-sha-256).
#   Exporta TEST_DATABASE_URL com o SUPERUSUÁRIO do cluster (o pacote @salon/db usa essa
#   conexão para migrar e criar os papéis app_*), executa o comando e destrói o cluster ao
#   sair, inclusive em erro ou Ctrl-C.
#
# Onde procura os binários (initdb, pg_ctl e psql), nesta ordem: PG_BIN_DIR; o initdb do PATH
# (Fedora, Arch, Homebrew linkado, Postgres.app); /usr/lib/postgresql/<versão>/bin (Debian e
# Ubuntu, a maior versão instalada); `pg_config --bindir`. Sem binários, ou com versão anterior
# à 16, sai com 69 e explica as alternativas (inclusive o compose.yaml da raiz).
#
# O PostgreSQL recusa rodar como root: como root, initdb/pg_ctl rodam como o usuário sem
# privilégio PG_EPHEMERAL_USER (padrão: postgres) via runuser.
#
# Testes: scripts/with-local-postgres.test.mjs (pnpm test:root).
#
# Variáveis opcionais:
#   PG_BIN_DIR          diretório dos binários (initdb, pg_ctl, psql)
#   PG_EPHEMERAL_USER   usuário sem privilégio usado quando o script roda como root
#   PG_EPHEMERAL_DB     nome do banco criado (padrão: app_test, o mesmo do CI)
#   PG_EPHEMERAL_KEEP=1 não apaga o diretório de dados ao sair (depuração)
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "uso: $0 <comando> [args...]" >&2
  exit 64
fi

if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
  exec "$@"
fi

log() { printf '[with-local-postgres] %s\n' "$*" >&2; }

# Versão mínima suportada pelo @salon/db (packages/db/README.md: compatível com 16 e 18).
REQUIRED_MAJOR=16

# Sai com 69 (EX_UNAVAILABLE): o motivo e as três formas de ter um PostgreSQL de teste.
no_usable_postgres() {
  log "$1"
  cat >&2 <<'EOF'
[with-local-postgres] O `pnpm test:db` precisa de um PostgreSQL 16+ de TESTE. Escolha uma saída:
  1. Binários locais do servidor (initdb, pg_ctl e psql): no PATH, em
     /usr/lib/postgresql/<versão>/bin ou pelo `pg_config`. Fora disso, exporte PG_BIN_DIR.
     macOS com Homebrew: PG_BIN_DIR="$(brew --prefix postgresql@16)/bin".
  2. Docker ou Podman: `docker compose up -d --wait postgres-test` e exporte a
     TEST_DATABASE_URL indicada no compose.yaml da raiz.
  3. Qualquer cluster DESCARTÁVEL: exporte TEST_DATABASE_URL com o superusuário dele.
No Windows, rode pelo WSL 2 (o script é bash).
EOF
  exit 69
}

find_bin_dir() {
  if [[ -n "${PG_BIN_DIR:-}" ]]; then
    printf '%s\n' "$PG_BIN_DIR"
    return
  fi
  local from_path
  if from_path="$(command -v initdb 2>/dev/null)" && [[ -n "$from_path" ]]; then
    dirname -- "$from_path"
    return
  fi
  local candidates
  candidates="$(find /usr/lib/postgresql -mindepth 2 -maxdepth 2 -type d -name bin 2>/dev/null | sort -V | tail -n 1 || true)"
  if [[ -n "$candidates" ]]; then
    printf '%s\n' "$candidates"
    return
  fi
  if command -v pg_config >/dev/null 2>&1; then
    pg_config --bindir
    return
  fi
  return 1
}

if ! BIN="$(find_bin_dir)"; then
  no_usable_postgres "PostgreSQL local não encontrado (initdb, pg_ctl e psql)."
fi
if [[ ! -x "$BIN/initdb" || ! -x "$BIN/pg_ctl" || ! -x "$BIN/psql" ]]; then
  no_usable_postgres "faltam initdb, pg_ctl ou psql em $BIN."
fi

# "initdb (PostgreSQL) 16.10 (Debian ...)" ou "initdb (PostgreSQL) 18beta1" -> 16 ou 18.
PG_MAJOR="$("$BIN/initdb" --version 2>/dev/null | sed -nE 's/^initdb \(PostgreSQL\) ([0-9]+).*/\1/p' | head -n 1 || true)"
if [[ ! "$PG_MAJOR" =~ ^[0-9]+$ ]]; then
  no_usable_postgres "não foi possível ler a versão de $BIN/initdb."
fi
if ((PG_MAJOR < REQUIRED_MAJOR)); then
  no_usable_postgres "PostgreSQL $PG_MAJOR em $BIN: o @salon/db exige $REQUIRED_MAJOR ou mais novo."
fi

DB_NAME="${PG_EPHEMERAL_DB:-app_test}"
if [[ ! "$DB_NAME" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  log "PG_EPHEMERAL_DB inválido: use apenas [a-z0-9_]."
  exit 64
fi

# Executa como o dono do cluster: o próprio usuário, ou o usuário sem privilégio se root.
if [[ "$(id -u)" -eq 0 ]]; then
  PG_USER="${PG_EPHEMERAL_USER:-postgres}"
  if ! id "$PG_USER" >/dev/null 2>&1; then
    log "rodando como root, mas o usuário '$PG_USER' não existe (defina PG_EPHEMERAL_USER)."
    exit 67
  fi
  as_pg() { runuser -u "$PG_USER" -- "$@"; }
else
  PG_USER="$(id -un)"
  as_pg() { "$@"; }
fi

# Diretório em /tmp (atravessável pelo usuário do cluster), acessível só pelo dono.
WORK_DIR="$(mktemp -d /tmp/salon-pg.XXXXXX)"
DATA_DIR="$WORK_DIR/data"
STARTED=0

# shellcheck disable=SC2329 # chamada pelo trap EXIT logo abaixo.
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$STARTED" -eq 1 ]]; then
    as_pg "$BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if [[ "${PG_EPHEMERAL_KEEP:-0}" == "1" ]]; then
    log "PG_EPHEMERAL_KEEP=1: dados mantidos em $WORK_DIR"
  else
    rm -rf -- "$WORK_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Senha aleatória (hex, segura em URL) só para esta execução.
PASSWORD="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
PWFILE="$WORK_DIR/pwfile"
printf '%s\n' "$PASSWORD" >"$PWFILE"
chmod 600 "$PWFILE"
if [[ "$(id -u)" -eq 0 ]]; then
  chown -R "$PG_USER" "$WORK_DIR"
fi
chmod 700 "$WORK_DIR"

if ! as_pg "$BIN/initdb" -D "$DATA_DIR" -U postgres --pwfile="$PWFILE" \
  --auth-local=scram-sha-256 --auth-host=scram-sha-256 \
  -E UTF8 --locale=C.UTF-8 --no-instructions >"$WORK_DIR/initdb.log" 2>&1; then
  log "initdb falhou:"
  cat "$WORK_DIR/initdb.log" >&2
  exit 70
fi
rm -f -- "$PWFILE"

free_port() {
  node -e "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});"
}

# Configuração de teste: rápida e descartável (sem durabilidade), UTC, só loopback.
start_cluster() {
  as_pg "$BIN/pg_ctl" -D "$DATA_DIR" -l "$WORK_DIR/server.log" -w -t 30 start -o \
    "-p $1 -c listen_addresses=127.0.0.1 -c unix_socket_directories=$WORK_DIR -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c timezone=UTC -c log_timezone=UTC -c max_connections=200" \
    >/dev/null 2>&1
}

PORT=""
for _ in 1 2 3 4 5; do
  candidate="$(free_port)"
  if start_cluster "$candidate"; then
    PORT="$candidate"
    STARTED=1
    break
  fi
  log "porta $candidate indisponível; tentando outra."
done
if [[ -z "$PORT" ]]; then
  log "não foi possível iniciar o PostgreSQL. Log do servidor:"
  tail -n 30 "$WORK_DIR/server.log" >&2 || true
  exit 70
fi

ADMIN_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}"
"$BIN/psql" "$ADMIN_URL/postgres" -v ON_ERROR_STOP=1 -qAt -c "CREATE DATABASE $DB_NAME" >/dev/null

export TEST_DATABASE_URL="$ADMIN_URL/$DB_NAME"
# Padrões da libpq (psql, pg_dump, node-postgres): uma conexão sem parâmetros também cai
# no cluster efêmero, por exemplo `psql ""` quando o chamador expandiu a variável cedo demais.
export PGHOST=127.0.0.1 PGPORT="$PORT" PGUSER=postgres PGPASSWORD="$PASSWORD" PGDATABASE="$DB_NAME"
log "PostgreSQL $("$BIN/psql" "$TEST_DATABASE_URL" -qAt -c 'show server_version') efêmero em 127.0.0.1:$PORT (banco $DB_NAME)."

set +e
"$@"
status=$?
set -e
exit "$status"
