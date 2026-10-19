#!/usr/bin/env bash
# Testes da decisão do job OSV-Scanner (.github/scripts/osv-gate.sh), com um osv-scanner falso
# que devolve o exit code e o JSON de cada cenário. Roda no CI antes da varredura real e
# localmente sem rede:
#
#   .github/scripts/osv-gate.test.sh [caminho-do-osv-gate.sh]
#
# O caso que motivou o script: com o osv.dev inacessível, o osv-scanner sai com 127 mas grava
# um JSON "limpo" (results vazio ou pacotes sem vulnerabilidade). Decidir pela existência do
# arquivo deixa o job verde sem ter consultado nada; a decisão tem de ser pelo exit code.
set -euo pipefail

GATE="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/osv-gate.sh}"

if [[ ! -x "$GATE" ]]; then
  echo "osv-gate.sh não encontrado ou sem permissão de execução: $GATE" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq é necessário" >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# osv-scanner falso: o diretório alvo (último argumento) traz o cenário em .fake-rc e
# .fake.json (com __DIR__ no lugar do caminho absoluto). Cada chamada é registrada no log.
FAKE="$WORK/fake-osv-scanner"
cat >"$FAKE" <<'FAKE_EOF'
#!/usr/bin/env bash
set -euo pipefail
out=''
for arg in "$@"; do
  case "$arg" in
    --output-file=*) out="${arg#--output-file=}" ;;
  esac
done
dir="${*: -1}"
printf '%s\n' "$*" >>"${FAKE_LOG:?}"
if [[ -n "$out" && -f "$dir/.fake.json" ]]; then
  sed "s#__DIR__#${dir}#g" "$dir/.fake.json" >"$out"
fi
exit "$(cat "$dir/.fake-rc" 2>/dev/null || echo 0)"
FAKE_EOF
chmod +x "$FAKE"

# JSON no formato do osv-scanner 2.x. Uso: mkjson <lockfile-relativo|""> [nome@versão:ID,ID ...]
mkjson() {
  local lock="$1"
  shift
  jq -n --arg lock "$lock" '
    {
      results: (if $lock == "" then [] else [{
        source: { path: ("__DIR__/" + $lock), type: "lockfile" },
        packages: [ $ARGS.positional[]
          | (split(":") | {pv: .[0], ids: (.[1] // "")})
          | (.pv | split("@")) as [$name, $version]
          | {
              package: { name: $name, version: $version, ecosystem: "npm" },
              vulnerabilities: (.ids | split(",") | map(select(. != ""))
                | map({ id: ., summary: ("resumo de " + .) }))
            } ]
      }] end),
      experimental_config: { licenses: { summary: false, allowlist: null } }
    }' --args "$@"
}

# cenario <dir> <exit-code> [args do mkjson | "--sem-json" | "--json-invalido"]
cenario() {
  local dir="$1" rc="$2"
  shift 2
  rm -rf "$dir"
  mkdir -p "$dir/.github"
  : >"$dir/.github/osv-scanner.toml"
  printf '%s' "$rc" >"$dir/.fake-rc"
  case "${1:-}" in
    --sem-json) ;;
    --json-invalido) printf 'isto não é json' >"$dir/.fake.json" ;;
    *) mkjson "$@" >"$dir/.fake.json" ;;
  esac
}

PASS=0
FAIL=0
# espera <nome> <exit esperado> <texto esperado na saída ou ""> <evento> <head> [<base>]
espera() {
  local nome="$1" want_rc="$2" want_text="$3" event="$4"
  shift 4
  local rc=0 output
  : >"$WORK/fake.log"
  output="$(EVENT_NAME="$event" FAKE_LOG="$WORK/fake.log" OSV_OUT_DIR="$WORK/out" \
    "$GATE" "$FAKE" "$@" 2>&1)" || rc=$?
  if [[ "$rc" -ne "$want_rc" ]]; then
    echo "FALHOU: $nome: exit $rc, esperado $want_rc"
    printf '%s\n' "$output" | sed 's/^/    /'
    FAIL=$((FAIL + 1))
    return
  fi
  if [[ -n "$want_text" ]] && ! grep -qF -- "$want_text" <<<"$output"; then
    echo "FALHOU: $nome: saída sem \"$want_text\""
    printf '%s\n' "$output" | sed 's/^/    /'
    FAIL=$((FAIL + 1))
    return
  fi
  echo "ok: $nome"
  PASS=$((PASS + 1))
}

H="$WORK/head"
B="$WORK/base"
LOCK="pnpm-lock.yaml"

# --- Pull request: comparação com a base ---
cenario "$H" 0 "$LOCK" "next@16.0.0:" "pg@8.16.0:"
cenario "$B" 0 ""
espera "PR limpo; base sem lockfile (bootstrap) vira linha de base vazia" 0 "" pull_request "$H" "$B"

if grep -q -- '--allow-no-lockfiles' <(head -n 1 "$WORK/fake.log"); then
  echo "FALHOU: o head não pode usar --allow-no-lockfiles"
  FAIL=$((FAIL + 1))
else
  echo "ok: o head é varrido sem --allow-no-lockfiles"
  PASS=$((PASS + 1))
fi
if grep -q -- "--allow-no-lockfiles" <(sed -n 2p "$WORK/fake.log") &&
  [[ "$(grep -o -- '--config=[^ ]*' "$WORK/fake.log" | sort -u | wc -l)" -eq 1 ]] &&
  grep -qF -- "--config=$H/.github/osv-scanner.toml" "$WORK/fake.log"; then
  echo "ok: a base usa --allow-no-lockfiles e a mesma config do head"
  PASS=$((PASS + 1))
else
  echo "FALHOU: chamadas inesperadas ao scanner:"
  sed 's/^/    /' "$WORK/fake.log"
  FAIL=$((FAIL + 1))
fi

cenario "$H" 127 "$LOCK" "next@16.0.0:" "pg@8.16.0:"
espera "PR: head com exit 127 e JSON 'limpo' (osv.dev inacessível) falha fechado" 1 "exit 127" \
  pull_request "$H" "$B"

cenario "$H" 127 ""
espera "PR: head com exit 127 e results vazio falha fechado" 1 "exit 127" pull_request "$H" "$B"

cenario "$H" 0 "$LOCK" "next@16.0.0:"
cenario "$B" 127 "$LOCK" "next@16.0.0:"
espera "PR: varredura da base com exit 127 falha fechado" 1 "exit 127" pull_request "$H" "$B"

cenario "$H" 1 "$LOCK" "braces@3.0.3:GHSA-aaaa-bbbb-cccc"
cenario "$B" 1 "$LOCK" "braces@3.0.3:GHSA-aaaa-bbbb-cccc"
espera "PR: vulnerabilidade que já existia na base não bloqueia" 0 "" pull_request "$H" "$B"

cenario "$H" 1 "$LOCK" "braces@3.0.3:GHSA-aaaa-bbbb-cccc" "lodash@4.17.20:GHSA-dddd-eeee-ffff"
espera "PR: vulnerabilidade nova bloqueia e é listada" 1 "GHSA-dddd-eeee-ffff" \
  pull_request "$H" "$B"

cenario "$H" 1 "$LOCK" "braces@3.0.3:GHSA-aaaa-bbbb-cccc" "braces@2.3.2:GHSA-aaaa-bbbb-cccc"
espera "PR: mais ocorrências do mesmo ID (nova versão afetada) bloqueia" 1 "GHSA-aaaa-bbbb-cccc" \
  pull_request "$H" "$B"

cenario "$H" 1 "apps/web/$LOCK" "braces@3.0.3:GHSA-aaaa-bbbb-cccc"
espera "PR: lockfile movido com as mesmas ocorrências não bloqueia" 0 "" pull_request "$H" "$B"

cenario "$H" 0 "$LOCK" "next@16.0.0:"
espera "PR sem diretório da base falha fechado" 1 "base" pull_request "$H"

# --- Erros do scanner (qualquer evento) ---
cenario "$H" 128 --sem-json
espera "head sem lockfile (exit 128) falha" 1 "exit 128" push "$H"

cenario "$H" 130 --sem-json
espera "configuração inválida (exit 130) falha" 1 "exit 130" push "$H"

cenario "$H" 0 --sem-json
espera "exit 0 sem arquivo de resultado falha" 1 "resultado" push "$H"

cenario "$H" 0 --json-invalido
espera "JSON inválido falha" 1 "JSON" push "$H"

cenario "$H" 0 ""
espera "nenhum pacote lido do $LOCK falha (lockfile não interpretado)" 1 "$LOCK" push "$H"

cenario "$H" 0 "outro/package-lock.json" "next@16.0.0:"
espera "pacotes só de outro lockfile não contam como leitura do $LOCK" 1 "$LOCK" push "$H"

cenario "$H" 1 "$LOCK" "next@16.0.0:"
espera "exit 1 sem vulnerabilidade no JSON é inconsistente e falha" 1 "inconsistente" push "$H"

cenario "$H" 0 "$LOCK" "lodash@4.17.20:GHSA-dddd-eeee-ffff"
espera "exit 0 com vulnerabilidade no JSON é inconsistente e falha" 1 "inconsistente" push "$H"

# --- Varredura completa (push, merge queue, manual, cron) ---
cenario "$H" 0 "$LOCK" "next@16.0.0:"
espera "push limpo passa" 0 "" push "$H"

cenario "$H" 1 "$LOCK" "lodash@4.17.20:GHSA-dddd-eeee-ffff"
espera "push com vulnerabilidade bloqueia e lista" 1 "GHSA-dddd-eeee-ffff" push "$H"
espera "merge queue com vulnerabilidade bloqueia" 1 "GHSA-dddd-eeee-ffff" merge_group "$H"
espera "execução manual com vulnerabilidade bloqueia" 1 "GHSA-dddd-eeee-ffff" workflow_dispatch "$H"
espera "cron com vulnerabilidade só avisa" 0 "GHSA-dddd-eeee-ffff" schedule "$H"

cenario "$H" 127 "$LOCK" "next@16.0.0:"
espera "cron com exit 127 falha (o aviso do cron vale só para vulnerabilidade)" 1 "exit 127" \
  schedule "$H"

espera "evento ausente falha" 1 "EVENT_NAME" "" "$H"

echo
echo "osv-gate: $PASS ok, $FAIL falha(s)"
[[ "$FAIL" -eq 0 ]]
