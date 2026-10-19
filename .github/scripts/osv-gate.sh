#!/usr/bin/env bash
# Varredura OSV-Scanner do security.yml com decisão pelo EXIT CODE e pelo conteúdo do JSON.
#
#   .github/scripts/osv-gate.sh <osv-scanner> <dir-do-head> [<dir-da-base>]
#
# Ambiente:
#   EVENT_NAME    evento do workflow: pull_request, push, merge_group, schedule ou
#                 workflow_dispatch (obrigatório).
#   OSV_OUT_DIR   onde gravar head.json e base.json (padrão: diretório temporário).
#   OSV_LOCKFILE  lockfile que o head precisa ter lido (padrão: pnpm-lock.yaml).
#
# Por que não o workflow reutilizável google/osv-scanner-action: ele decide pela EXISTÊNCIA do
# arquivo de resultado, e o osv-scanner 2.x grava um JSON "limpo" mesmo quando sai com erro
# (ex.: osv.dev inacessível), o que deixava o job verde sem ter consultado nada; e a imagem
# dele é puxada por tag, sem digest.
#
# Exit codes do osv-scanner 2.x: 0 sem vulnerabilidade; 1 com vulnerabilidade; 127 erro geral
# (inclusive rede); 128 nenhum lockfile; 130 configuração inválida. Só 0 e 1 são resultado de
# varredura: qualquer outro falha fechado, em qualquer evento.
#
# Regras:
#   - A config é a do head (<dir-do-head>/.github/osv-scanner.toml) nas duas varreduras, então
#     a base não precisa ter o arquivo (bootstrap) e os riscos aceitos valem igual dos dois lados.
#   - O head precisa ter lido pacotes do OSV_LOCKFILE: lockfile não interpretado falha.
#   - pull_request: compara com a base por ocorrência de cada ID, como o osv-reporter; só falha
#     se o PR aumentar a contagem de algum ID. Base sem lockfile vira linha de base vazia
#     (--allow-no-lockfiles só na base).
#   - Demais eventos: qualquer vulnerabilidade falha, salvo no cron (schedule), que só avisa
#     (o Renovate abre o PR de correção a partir do alerta).
set -euo pipefail

usage='uso: osv-gate.sh <osv-scanner> <dir-do-head> [<dir-da-base>]'
SCANNER="${1:?$usage}"
HEAD_DIR="${2:?$usage}"
BASE_DIR="${3:-}"
LOCKFILE="${OSV_LOCKFILE:-pnpm-lock.yaml}"
OUT_DIR="${OSV_OUT_DIR:-$(mktemp -d)}"

erro() {
  echo "::error::OSV-Scanner: $*"
  exit 1
}

[[ -n "${EVENT_NAME:-}" ]] || erro "EVENT_NAME não definido."
command -v jq >/dev/null 2>&1 || erro "jq é necessário."
[[ -d "$HEAD_DIR" ]] || erro "diretório do head não encontrado: $HEAD_DIR"
HEAD_DIR="$(cd "$HEAD_DIR" && pwd)"
CONFIG="$HEAD_DIR/.github/osv-scanner.toml"
[[ -f "$CONFIG" ]] || erro "configuração não encontrada: $CONFIG"
mkdir -p "$OUT_DIR"

# varrer <rótulo> <dir> <saída.json> [flags extras]: roda o scanner e valida exit code e JSON.
varrer() {
  local label="$1" dir="$2" out="$3"
  shift 3
  local rc=0
  rm -f "$out"
  "$SCANNER" scan source --format=json "--output-file=$out" "--config=$CONFIG" --all-packages \
    --recursive "$@" "$dir" >&2 || rc=$?
  case "$rc" in
    0 | 1) ;;
    128) erro "$label: nenhum lockfile encontrado (exit 128)." ;;
    130) erro "$label: configuração inválida em $CONFIG (exit 130)." ;;
    *) erro "$label: o scanner falhou (exit $rc), por exemplo com o osv.dev inacessível. Um JSON gravado assim não prova ausência de vulnerabilidade: falha fechado." ;;
  esac
  [[ -s "$out" ]] || erro "$label: exit $rc sem arquivo de resultado ($out)."
  jq -e '(.results | type) == "array"' "$out" >/dev/null 2>&1 ||
    erro "$label: resultado não é um JSON do osv-scanner ($out)."
  local vulns
  vulns="$(jq '[.results[].packages[]?.vulnerabilities[]?] | length' "$out")"
  if { [[ "$rc" -eq 1 ]] && [[ "$vulns" -eq 0 ]]; } || { [[ "$rc" -eq 0 ]] && [[ "$vulns" -gt 0 ]]; }; then
    erro "$label: resultado inconsistente (exit $rc com $vulns vulnerabilidade(s) no JSON)."
  fi
}

# Contagem de ocorrências por ID de vulnerabilidade: {"GHSA-...": 2, ...}
ocorrencias() {
  jq -c '[.results[].packages[]?.vulnerabilities[]?.id] | group_by(.) | map({key: .[0], value: length}) | from_entries' "$1"
}

# listar <json> [ids em JSON]: uma linha por pacote afetado (todos, ou só os IDs dados).
listar() {
  local ids="${2:-null}"
  jq -r --argjson ids "$ids" --arg root "$HEAD_DIR/" '
    .results[] | (.source.path | ltrimstr($root)) as $src
    | .packages[]? | .package as $p
    | .vulnerabilities[]? | select($ids == null or (.id as $i | $ids | index($i)))
    | "  \(.id)  \($p.ecosystem) \($p.name)@\($p.version)  (\($src))  \(.summary // "")"' "$1"
}

HEAD_JSON="$OUT_DIR/head.json"
varrer "head" "$HEAD_DIR" "$HEAD_JSON"

lidos="$(jq --arg lf "/$LOCKFILE" \
  '[.results[] | select(.source.path | endswith($lf)) | .packages | length] | add // 0' "$HEAD_JSON")"
[[ "$lidos" -gt 0 ]] ||
  erro "head: nenhum pacote lido do $LOCKFILE. O lockfile não foi interpretado (formato novo?): falha fechado."
echo "head: $lidos pacote(s) lido(s) do $LOCKFILE."

if [[ "$EVENT_NAME" == "pull_request" ]]; then
  [[ -n "$BASE_DIR" && -d "$BASE_DIR" ]] || erro "pull_request sem o diretório da base para comparar."
  BASE_JSON="$OUT_DIR/base.json"
  varrer "base" "$(cd "$BASE_DIR" && pwd)" "$BASE_JSON" --allow-no-lockfiles
  novos="$(jq -n -c --argjson old "$(ocorrencias "$BASE_JSON")" --argjson new "$(ocorrencias "$HEAD_JSON")" \
    '[$new | to_entries[] | select(.value > ($old[.key] // 0)) | .key]')"
  if [[ "$novos" != "[]" ]]; then
    echo "::error::OSV-Scanner: vulnerabilidade(s) nova(s) neste PR: $(jq -r 'join(", ")' <<<"$novos")"
    listar "$HEAD_JSON" "$novos"
    echo "Corrija a versão ou, se o risco for aceito, registre o ID em .github/osv-scanner.toml e no audit.ignore do pnpm-workspace.yaml, com justificativa e ignoreUntil."
    exit 1
  fi
  existentes="$(jq '[.results[].packages[]?.vulnerabilities[]?] | length' "$HEAD_JSON")"
  echo "Nenhuma vulnerabilidade nova em relação à base ($existentes ocorrência(s) já existente(s))."
  exit 0
fi

if [[ "$(jq '[.results[].packages[]?.vulnerabilities[]?] | length' "$HEAD_JSON")" -eq 0 ]]; then
  echo "Nenhuma vulnerabilidade conhecida."
  exit 0
fi
if [[ "$EVENT_NAME" == "schedule" ]]; then
  echo "::warning::OSV-Scanner: vulnerabilidade(s) conhecida(s); o cron só avisa (o Renovate abre a correção)."
  listar "$HEAD_JSON"
  exit 0
fi
echo "::error::OSV-Scanner: vulnerabilidade(s) conhecida(s) nas dependências."
listar "$HEAD_JSON"
echo "Corrija a versão ou, se o risco for aceito, registre o ID em .github/osv-scanner.toml e no audit.ignore do pnpm-workspace.yaml, com justificativa e ignoreUntil."
exit 1
