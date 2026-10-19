#!/usr/bin/env bash
# Servidor MCP do Playwright para o Claude Code (referenciado em .mcp.json).
#
# - Usa o Playwright do app (@salon/web), travado no pnpm-lock.yaml: mesma quarentena
#   (minimumReleaseAge), lockfile e Renovate das outras dependências. Nada de npx nem de
#   download em tempo de execução.
# - Navegador: PLAYWRIGHT_MCP_EXECUTABLE_PATH, se definida; senão o Chromium da versão do
#   Playwright; se ele não estiver baixado (container da nuvem sem acesso ao CDN), a maior
#   revisão em PLAYWRIGHT_BROWSERS_PATH (mesma regra de apps/web/playwright.config.ts).
# - Perfil isolado em memória, headless, service workers bloqueados, origens limitadas ao
#   dev (3000) e ao build do E2E (3100); saída em test-results/ (ignorado pelo git).
# - stdout é o canal JSON-RPC do MCP: diagnósticos vão para stderr.
#
# PLAYWRIGHT_MCP_PRINT_ARGS=1 só imprime os argumentos, um por linha (testes do kit).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

resolve_executable() {
  if [ -n "${PLAYWRIGHT_MCP_EXECUTABLE_PATH:-}" ]; then
    printf '%s\n' "$PLAYWRIGHT_MCP_EXECUTABLE_PATH"
    return 0
  fi
  local expected=""
  if [ -d "$REPO_ROOT/apps/web" ]; then
    expected="$(cd "$REPO_ROOT/apps/web" && node -e \
      "process.stdout.write(require('@playwright/test').chromium.executablePath())" \
      2>/dev/null || true)"
  fi
  if [ -n "$expected" ] && [ -x "$expected" ]; then
    return 0
  fi
  local dir="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
  [ -d "$dir" ] || return 0
  local best="" best_rev=-1 entry rev bin
  for entry in "$dir"/chromium-*; do
    [ -d "$entry" ] || continue
    rev="${entry##*/chromium-}"
    [[ "$rev" =~ ^[0-9]+$ ]] || continue
    [ "$rev" -gt "$best_rev" ] || continue
    for bin in chrome-linux64/chrome chrome-linux/chrome; do
      if [ -x "$entry/$bin" ]; then
        best="$entry/$bin"
        best_rev="$rev"
        break
      fi
    done
  done
  if [ -n "$best" ]; then
    printf '[playwright-mcp] Chromium da versão do Playwright ausente; usando %s.\n' "$best" >&2
    printf '%s\n' "$best"
  fi
}

args=(
  --headless
  --isolated
  --browser chromium
  --block-service-workers
  --output-dir "$REPO_ROOT/test-results/playwright-mcp"
  --allowed-origins "http://localhost:3000;http://127.0.0.1:3000;http://127.0.0.1:3100"
)
executable="$(resolve_executable)"
if [ -n "$executable" ]; then
  args+=(--executable-path "$executable")
fi
args+=("$@")

if [ "${PLAYWRIGHT_MCP_PRINT_ARGS:-}" = "1" ]; then
  printf '%s\n' "${args[@]}"
  exit 0
fi

cd "$REPO_ROOT"
exec pnpm --silent --filter @salon/web exec playwright mcp "${args[@]}"
