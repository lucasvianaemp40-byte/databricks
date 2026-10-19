#!/usr/bin/env bash
# SessionStart (startup|resume): prepara sessões na nuvem (claude.ai/code).
#
# - Só age com CLAUDE_CODE_REMOTE=true; localmente sai na hora (o dev instala sozinho).
# - Ativa o pnpm exato do campo packageManager via corepack.
# - Roda `pnpm install --frozen-lockfile` só quando lockfile, workspace, package.json,
#   versão do Node/pnpm ou este script mudaram (hash em node_modules/.cache/).
# - Tenta registrar origin/HEAD (o guard-files usa a branch padrão para tornar as
#   migrações publicadas imutáveis).
# - NUNCA falha a sessão: qualquer erro vira aviso no contexto e exit 0.
# A saída padrão vira contexto para o Claude; mantenha-a curta.
set -u

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

LOG="${TMPDIR:-/tmp}/claude-session-start.log"

# with_timeout <segundos> <comando...>: usa `timeout` quando existe.
with_timeout() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  else
    "$@"
  fi
}

# with_lock <comando...>: serializa instalações concorrentes (aceita funções do shell).
with_lock() {
  if command -v flock >/dev/null 2>&1; then
    (
      flock -w 600 9 || exit 1
      "$@"
    ) 9>"${TMPDIR:-/tmp}/claude-pnpm-install.lock"
  else
    "$@"
  fi
}

install_hash() {
  local inputs=(package.json .claude/hooks/session-start.sh)
  local f
  for f in pnpm-lock.yaml pnpm-workspace.yaml .npmrc .nvmrc apps/*/package.json packages/*/package.json; do
    if [ -f "$f" ]; then inputs+=("$f"); fi
  done
  {
    sha256sum "${inputs[@]}" 2>/dev/null
    node --version 2>/dev/null
    pnpm --version 2>/dev/null
  } | sha256sum | cut -d' ' -f1
}

main() {
  local root="${CLAUDE_PROJECT_DIR:-$PWD}"
  if ! cd "$root" 2>/dev/null; then
    echo "AVISO(session-start): diretório do projeto inacessível: $root"
    return 0
  fi
  [ -f package.json ] || return 0
  : >"$LOG" 2>/dev/null || LOG=/dev/null

  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  export TURBO_TELEMETRY_DISABLED=1
  export NEXT_TELEMETRY_DISABLED=1

  if command -v corepack >/dev/null 2>&1; then
    if ! with_timeout 120 corepack enable pnpm >>"$LOG" 2>&1; then
      echo "AVISO(session-start): corepack enable pnpm falhou; veja $LOG."
    fi
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "AVISO(session-start): pnpm indisponível; ative com corepack antes de rodar testes."
    return 0
  fi

  mkdir -p node_modules/.cache 2>/dev/null || true
  local stamp=node_modules/.cache/claude-session-install.sha256
  local current
  current="$(install_hash)"
  if [ -d node_modules/.pnpm ] && [ -f "$stamp" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$current" ]; then
    echo "Dependências em dia (pnpm $(pnpm --version 2>/dev/null), node $(node --version 2>/dev/null))."
  elif with_lock with_timeout 540 pnpm install --frozen-lockfile --prefer-offline >>"$LOG" 2>&1; then
    mkdir -p node_modules/.cache 2>/dev/null || true
    echo "$current" >"$stamp" 2>/dev/null || true
    echo "Dependências instaladas (pnpm install --frozen-lockfile)."
  else
    rm -f "$stamp" 2>/dev/null || true
    echo "AVISO(session-start): pnpm install --frozen-lockfile falhou; veja $LOG antes de rodar testes."
  fi

  if git rev-parse --git-dir >/dev/null 2>&1 && ! git symbolic-ref -q refs/remotes/origin/HEAD >/dev/null 2>&1; then
    with_timeout 20 git remote set-head origin --auto >>"$LOG" 2>&1 || true
  fi
  return 0
}

main || true
exit 0
