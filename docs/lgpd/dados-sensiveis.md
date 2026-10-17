# Dados sensíveis: anamnese, ficha técnica e fotos

Salões coletam **ficha técnica** (fórmula de coloração, numeração da máquina) e **anamnese**
(alergias, gestação, medicamentos, condições de pele ou couro cabeludo). Alergia, gestação e
condição de saúde são **dado referente à saúde**, logo **dado pessoal sensível** (LGPD, art.
5º, II, e art. 11). Nada disto existe na fundação: a tabela e os controles entram com a feature
(fase 2 do [roadmap](../produto/mvp-e-roadmap.md)). **Enquadramento a validar com jurídico.**

## 1. Base legal

- **Consentimento específico e destacado** do titular para uma finalidade específica (art. 11,
  I). O texto separa:
  - registrar dados de saúde para a segurança do procedimento;
  - (opcional e separado) usar a foto em portfólio ou redes sociais.
- O salão em regra **não é profissional ou serviço de saúde**, então a hipótese de tutela da
  saúde (art. 11, II, "f") não se aplica.
- A tese da "proteção da vida ou da incolumidade física" (art. 11, II, "e"), por exemplo um
  alerta de alergia a química, precisa de validação jurídica antes de ser usada.
- **Fotos de antes e depois:** como registro técnico do serviço, art. 7º, V. Para **portfólio**,
  consentimento específico, mais o direito de imagem. Foto comum não é dado biométrico por si
  só, mas **nunca** aplicar reconhecimento facial nem extrair template biométrico, porque isso
  a tornaria dado sensível.
- **Crianças:** consentimento específico de um dos pais ou responsável (art. 14, § 1º).

## 2. Requisitos de produto

- Anamnese e ficha técnica ficam numa **tabela própria** (`client_records` no modelo de
  domínio), nunca em campos de observação gerais. A UI de observações avisa: "não registre
  aqui informações de saúde".
- Tipo de registro: `ficha_tecnica` (sem saúde), `anamnese` (com saúde) e `observacao`, com a
  marca `contains_health_data`.
- O consentimento `health_data` precisa estar vigente para gravar ou ler anamnese. A revogação
  dispara a eliminação.
- Formulário de anamnese com **campos fechados** sempre que possível (minimização), e texto livre
  com limite de tamanho.

## 3. Requisitos de engenharia

| Controle | Detalhe | ASVS |
|---|---|---|
| Criptografia de campo | AES-256-GCM com **DEK por tenant**, cifrada por uma KEK (KMS ou segredo versionado); nonce de 96 bits; AAD = `tenant_id`, `client_id` e coluna (impede copiar o ciphertext entre linhas ou tenants); rotação da KEK sem recifrar os dados | 11.3.2, 11.3.3 |
| Crypto-shredding | encerrar o tenant destrói a DEK, o que torna os campos ilegíveis inclusive nos backups | — |
| Acesso por papel | só papéis autorizados pelo salão (por exemplo, o profissional que atende e o dono). A recepção não lê por padrão | 8.2.3 |
| Step-up | leitura e exportação exigem sessão recente | 7.5.1 |
| Auditoria de leitura | toda leitura grava quem, quando, qual titular e o motivo (append-only). Painel para o dono. Alerta para leitura atípica, como mais de 50 fichas por hora por usuário | 16.3.x |
| Falha fechada | erro de cifra aborta a transação e nunca grava em claro | 16.5.3 |
| Fora de logs e erros | nada de anamnese em log, Sentry, analytics, URL ou prompt de IA (regra Semgrep `pii-in-logs` + redaction) | 16.2.5 |
| Exportação | só para o titular (OTP) ou para o dono com step-up; nunca em massa sem auditoria | — |
| Fotos | bucket privado com caminho `tenants/<tenant>/customers/<customer>/<uuid>.jpg`; URL assinada de curta duração gerada **depois** da checagem no DAL; EXIF removido; tamanho e tipo validados | V5, 14.2.8 |
| CSP | o bucket entra em `img-src` só para a origem exata | 3.4.3 |
| Retenção | até a revogação ou o fim da relação ([retenção](retencao.md)) | — |

## 4. RIPD

Fazer o **Relatório de Impacto à Proteção de Dados** (art. 38) antes de lançar a anamnese e as
fotos, com:

- descrição do tratamento, finalidade, base legal e titulares (inclusive menores);
- necessidade e proporcionalidade (por que cada campo existe);
- riscos (vazamento, acesso indevido pela equipe, uso para outra finalidade) e medidas (seção
  3);
- parecer do encarregado.

Use o [modelo de threat model](../seguranca/threat-models/README.md) com LINDDUN como insumo
técnico.

## 5. Dados sensíveis acidentais

Mesmo sem anamnese, textos livres podem conter saúde:

- `time_off.note`: "consulta médica" do profissional;
- `appointments.cancellation_reason`: "estou doente";
- nomes de serviço que revelam condição de saúde.

Mitigações: limite de tamanho (já existe nos CHECKs da fundação), aviso na UI, inclusão desses
campos na exportação e na anonimização, e nunca usá-los em analytics.
