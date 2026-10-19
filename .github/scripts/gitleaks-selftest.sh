#!/usr/bin/env bash
# Autoteste das regras próprias do .gitleaks.toml (CPF/CNPJ, Mercado Pago, WhatsApp/Meta,
# URL de PostgreSQL com senha).
#
#   .github/scripts/gitleaks-selftest.sh [caminho-do-gitleaks] [caminho-do-.gitleaks.toml]
#
# Os exemplos são montados em tempo de execução, a partir de pedaços, num diretório temporário:
# o repositório nunca contém um "segredo de exemplo" que dispare a própria varredura, o push
# protection do GitHub ou scanners de terceiros. Falha (exit 1) se uma regra deixar de achar o
# exemplo positivo dela ou se algum exemplo negativo gerar achado.
set -euo pipefail

GITLEAKS="${1:-gitleaks}"
CONFIG="${2:-$(git rev-parse --show-toplevel)/.gitleaks.toml}"

if ! command -v "$GITLEAKS" >/dev/null 2>&1 && [[ ! -x "$GITLEAKS" ]]; then
  echo "gitleaks não encontrado: $GITLEAKS" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq é necessário para ler o relatório do gitleaks" >&2
  exit 2
fi
if [[ ! -f "$CONFIG" ]]; then
  echo "configuração não encontrada: $CONFIG" >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Texto aleatório só com [A-Za-z0-9], com entropia alta (como um token real).
random_alnum() {
  local length="$1" out=''
  while ((${#out} < length)); do
    out+="$(head -c 256 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
  done
  printf '%s' "${out:0:length}"
}
random_hex() {
  head -c 256 /dev/urandom | od -An -tx1 | tr -dc '0-9a-f' | head -c "$1"
}

mkdir -p "$WORK/positive/src" "$WORK/negative/src" "$WORK/negative/test/fixtures"

# --- Positivos: cada linha deve disparar exatamente a regra indicada no nome do arquivo. ---
# CPF/CNPJ com dígitos verificadores inválidos: não podem pertencer a ninguém.
printf "export const doc = '%s.%s.%s-%s';\n" 987 654 321 99 >"$WORK/positive/src/br-cpf.ts"
printf "export const doc = '%s.%s.%s/%s-%s';\n" 98 765 432 0001 99 >"$WORK/positive/src/br-cnpj.ts"
printf "export const doc = '%s.%s.%s/%s-%s';\n" AB CDE FGH 0001 99 >"$WORK/positive/src/br-cnpj-alfanumerico.ts"
printf "MP_ACCESS_TOKEN=%s-%s-%s-%s-%s\n" APP_USR 1234567890123456 101726 "$(random_hex 32)" 123456789 \
  >"$WORK/positive/src/mercadopago-access-token.env"
printf "MERCADO_PAGO_WEBHOOK_SECRET=%s\n" "$(random_hex 64)" >"$WORK/positive/src/mercadopago-webhook-secret.env"
printf "const token = '%s%s';\n" EAAG "$(random_alnum 160)" >"$WORK/positive/src/meta-whatsapp-access-token.ts"
printf "WHATSAPP_APP_SECRET=%s\n" "$(random_alnum 32)" >"$WORK/positive/src/whatsapp-app-secret.env"
printf "DATABASE_URL=postgresql://app_user:%s@ep-exemplo-123456.sa-east-1.aws.neon.tech/app\n" \
  "$(random_alnum 24)" >"$WORK/positive/src/postgres-url-with-password.env"

# --- Negativos: nada aqui pode gerar achado. ---
{
  printf "// CPF/CNPJ sintéticos da allowlist\n"
  printf "export const a = '%s.%s.%s-%s';\n" 123 456 789 09
  printf "export const b = '%s.%s.%s-%s';\n" 111 111 111 11
  printf "export const c = '%s.%s.%s/%s-%s';\n" 11 222 333 0001 81
  printf "// Banco local de teste e placeholder de documentação\n"
  printf "TEST_DATABASE_URL=postgresql://%s:%s@localhost:5432/app_test\n" postgres ci_only_not_a_secret
  printf "TEST_DATABASE_URL=postgresql://%s:%s@127.0.0.1:5432/app_test\n" postgres ci_only_not_a_secret
  printf "DATABASE_URL=postgresql://app_user:<senha>@db.exemplo.com.br:5432/app\n"
  printf "// Chave PÚBLICA do Mercado Pago (vai para o navegador; não é segredo)\n"
  printf "NEXT_PUBLIC_MP_PUBLIC_KEY=%s-%s\n" APP_USR 3f0e8a2c-1b2d-4c5e-9f60-7a8b9c0d1e2f
  printf "const label = 'EAA curto';\n"
} >"$WORK/negative/src/allowed.env"
# Documento formatado em fixture de teste (allowlist por caminho).
printf "export const customerDoc = '%s.%s.%s-%s';\n" 987 654 321 99 >"$WORK/negative/test/fixtures/customers.ts"

run_gitleaks() {
  local dir="$1" report="$2"
  "$GITLEAKS" dir "$dir" --config "$CONFIG" --no-banner --redact --log-level error \
    --report-format json --report-path "$report" --exit-code 0
}

status=0

run_gitleaks "$WORK/positive" "$WORK/positive.json"
for file in "$WORK"/positive/src/*; do
  name="$(basename "$file")"
  rule="${name%.*}"
  rule="${rule%-alfanumerico}"
  if jq -e --arg rule "$rule" --arg file "/${name}" \
    'any(.[]; .RuleID == $rule and (.File | endswith($file)))' "$WORK/positive.json" >/dev/null; then
    echo "ok    ${rule} encontrou ${name}"
  else
    echo "FALHA ${rule} não encontrou ${name}" >&2
    status=1
  fi
done

run_gitleaks "$WORK/negative" "$WORK/negative.json"
negatives="$(jq 'length' "$WORK/negative.json")"
if [[ "$negatives" -eq 0 ]]; then
  echo "ok    nenhum falso positivo nos exemplos negativos"
else
  echo "FALHA ${negatives} achado(s) em exemplos negativos:" >&2
  jq -r '.[] | "  \(.RuleID) \(.File):\(.StartLine)"' "$WORK/negative.json" >&2
  status=1
fi

exit "$status"
