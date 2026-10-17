# Política de segurança

O Agenda Salão guarda a agenda e os dados de clientes de salões de beleza e barbearias. Levamos
a sério qualquer falha que permita a um salão ver dados de outro, a alguém agir sem permissão ou
a dados pessoais vazarem. Obrigado por ajudar a proteger esses dados.

## Como relatar uma vulnerabilidade

**Não abra issue, discussão ou pull request público** para falha de segurança.

Use o **relato privado de vulnerabilidade do GitHub**: aba **Security** do repositório >
**Report a vulnerability** (ou
[este link](https://github.com/lucasvianaemp40-byte/databricks/security/advisories/new)).
Somente os mantenedores veem o relato, e a conversa e a correção acontecem num advisory privado.

Enquanto o produto não tem domínio próprio, esse é o único canal oficial. Desconfie de qualquer
outro endereço que se apresente como canal de segurança do projeto.

### O que incluir

- descrição da falha e do impacto (o que um atacante consegue ver ou fazer);
- passos para reproduzir, com URLs, requisições ou código mínimo;
- papel e tipo de conta usados (dono, recepção, profissional, cliente final, anônimo);
- versão, commit ou data e hora (com fuso) em que observou o problema;
- se for o caso, como você contornaria a falha.

Não inclua no relato dados pessoais reais de terceiros. Se a falha expõe esse tipo de dado,
descreva o tipo e a quantidade sem copiá-los.

## O que esperar

| Etapa | Prazo |
|---|---|
| Confirmação de recebimento | até 3 dias úteis |
| Primeira avaliação (validade e severidade, CVSS 4.0) | até 7 dias corridos |
| Correção em produção: severidade crítica | até 7 dias corridos |
| Correção em produção: severidade alta | até 30 dias corridos |
| Correção em produção: severidade média ou baixa | até 90 dias corridos |

Mantemos você informado durante a correção. Quando ela estiver em produção, publicamos um
advisory e damos crédito a quem relatou, se a pessoa quiser.

## Divulgação coordenada

Pedimos que a falha não seja divulgada antes da correção ou de 90 dias após o relato, o que vier
primeiro. Se a falha estiver sendo explorada ativamente, podemos combinar um prazo menor.

## Escopo

Dentro do escopo:

- o aplicativo web (página pública de agendamento e painel do salão) e suas APIs;
- isolamento entre salões (multi-tenant), autenticação, autorização e sessão;
- exposição de dados pessoais de clientes, profissionais ou donos de salão;
- este repositório: workflows do GitHub Actions, configuração de dependências e de agentes.

Fora do escopo:

- negação de serviço por volume, spam ou testes de carga;
- engenharia social, phishing ou ataques físicos;
- falhas em serviços de terceiros (provedor de nuvem, gateway de pagamento, WhatsApp), que
  devem ir ao respectivo fornecedor (avise-nos se afetar o produto);
- achados sem impacto demonstrável, como ausência de cabeçalho em página estática sem dados,
  versões de software sem vulnerabilidade explorável ou relatórios automáticos sem validação.

## Regras para testes de boa-fé

Não tomaremos medida legal contra quem pesquisar e relatar de boa-fé e seguindo estas regras:

- teste apenas com contas e salões criados por você; nunca acesse, altere ou apague dados de
  outras pessoas além do mínimo necessário para provar a falha;
- ao encontrar dado pessoal de terceiros, pare, não guarde cópia e relate imediatamente;
- não use varredura automatizada agressiva contra produção nem degrade o serviço;
- não envie mensagens (WhatsApp, SMS, e-mail) a clientes reais dos salões;
- não exija pagamento como condição para relatar. Ainda não há programa de recompensas.

## Incidentes com dados pessoais (LGPD)

Se a falha resultar em incidente com dados pessoais, seguimos a Lei nº 13.709/2018 (LGPD) e a
regulamentação da ANPD: avaliamos o risco aos titulares, comunicamos os salões afetados (que são
os controladores dos dados dos clientes deles) e, quando exigido, a ANPD e os titulares no prazo
regulamentar (hoje, 3 dias úteis pela Resolução CD/ANPD nº 15/2024). Todo incidente fica
registrado, mesmo quando não precisa ser comunicado.

## Versões suportadas

O Agenda Salão é um serviço (SaaS): só a versão em produção recebe correções. Não há versões
instaláveis mantidas em paralelo.

## Práticas de segurança do projeto

Resumo do que o repositório aplica automaticamente em cada mudança:

- isolamento entre salões no banco (Row Level Security com `FORCE`) testado no CI contra um
  PostgreSQL real;
- análise estática (Semgrep com regras próprias de multi-tenant, LGPD e fuso; CodeQL), varredura
  de segredos (gitleaks), de dependências (OSV-Scanner, Trivy, `pnpm audit` e verificação de
  assinaturas do registry) e dos próprios workflows (zizmor, actionlint);
- dependências com quarentena de 3 dias, scripts de instalação bloqueados por padrão e lockfile
  congelado; actions e imagens fixadas por SHA ou digest;
- varredura dinâmica (OWASP ZAP baseline) contra o build de produção.
