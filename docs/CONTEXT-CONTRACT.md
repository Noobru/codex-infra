# Contrato de contexto: vault e G-IDEIA

Esta distribuição pressupõe um vault de coding equivalente já disponível para o destinatário. Ele é a fonte básica de verdade de engenharia: contratos de agentes, práticas curadas, estado técnico dos projetos e seus artefatos canônicos. A infraestrutura registra e executa trabalho com base nessas fontes.

## Compatibilidade necessária

O vault precisa ter um ponto de entrada legível pelo agente, instruções aplicáveis e conhecimento pertinente aos projetos. O G-IDEIA deve estar adotado antes da engenharia: preserve o contrato existente ou use o bootstrap complementar do pacote quando faltar. Os projetos devem permitir localizar PRD, PREVC, referências técnicas e evidências sem depender do histórico de uma única conversa. A organização física pode seguir o vault do destinatário; os caminhos e labels são configurados localmente.

G-IDEIA permanece obrigatório para formalização e engenharia. Esta página explica a integração com CodexInfra; o módulo complementar fornece método e templates e preserva contratos já adotados. Sua aplicação não cria outro PRD/PREVC quando há fonte canônica existente. Não se exige copiar os vaults pessoais do autor, e criar pastas vazias não atende ao pré-requisito de conhecimento curado.

`Configure-Local` prepara apenas o perfil da infraestrutura, seu MCP e a política de workers. O `doctor` verifica runtime, dependências e resolução do cadastro. Nenhum deles atesta conteúdo do vault, cumprimento do G-IDEIA ou prontidão de um projeto.

## Bootstrap complementar

`scripts/Bootstrap-GIdeia.mjs` usa o módulo canônico `src/g-ideia-bootstrap.ts`. Prepare um arquivo local de entrada e examine o preview antes de aplicar:

```powershell
node scripts/Bootstrap-GIdeia.mjs --input bootstrap.local.json
node scripts/Bootstrap-GIdeia.mjs --input bootstrap.local.json --apply
```

| Entrada | Significado |
|---|---|
| `vaultPath` | Caminho absoluto do vault existente, resolvido no computador receptor. |
| `project` | Objeto opcional. Ausente: adotar apenas o contrato complementar. |
| `project.id`, `project.name`, `project.code` | Identidade do projeto e código de sua série de notas. Escolher conforme o vault existente. |
| `project.root` | Caminho absoluto do workspace existente do projeto. |
| `project.filenames` | Mapeamento opcional de `index`, `prd`, `prevc`, `spec` e `evidence` para os nomes canônicos do projeto. |
| `project.reuseExisting` | Use `true` para vincular documentos canônicos já preenchidos, preservando seu conteúdo. O padrão é `false`. |
| `project.checks` | Checks opcionais para um perfil novo, conforme `ProfileSchema`. Checks e permissões de perfil existente são preservados. |
| `expectedContractSha256` | Hash opcional retornado pelo preview; impede aplicar sobre um contrato alterado desde a revisão. |

Os caminhos pertencem ao arquivo local ignorado; não entram no código distribuído. O bootstrap requer vault existente com `AGENTS.md` e a área `600 - Projetos`. Isso verifica estrutura mínima, não a qualidade ou completude do conhecimento curado. O agente ainda precisa ler os contratos e notas pertinentes.

O preview consulta somente metadados necessários e não grava, executa checks ou inicia modelo. A aplicação preserva o conteúdo anterior de `AGENTS.md`, guarda backup local quando houver alteração e acrescenta o bloco complementar delimitado. G-IDEIA já existente é reconhecido sem duplicar o contrato. Divergências em artefatos existentes precisam de reconciliação explícita; o script não decide substituí-los.

Com projeto informado, o bootstrap pode criar cinco notas: índice/control plane local, PRD, PREVC, SPEC e Evidências, e registrar o perfil pelas classes canônicas. O perfil novo começa com `checks: []`; cadastre os checks reais após revisar o projeto, antes de preparar execução. Os templates são estrutura inicial a preencher e revisar, sem afirmar requisito concluído, gate aprovado ou prontidão. Projeto já documentado reaproveita seus arquivos canônicos. A integração com Notion, quando exigida pelo contrato, continua uma ação do agente com fonte e read-back; o bootstrap não publica páginas nem requer credenciais desse serviço.

## Caminho de trabalho

1. **Conversa e discovery:** esclarecer problema, evidências, hipóteses e intenção. Registrar continuidade não autoriza construir.
2. **Formalização proporcional:** aplicar o G-IDEIA canônico para manter PRD/PREVC e SPEC/ADRs quando pertinentes à complexidade. Em projeto existente, localizar e atualizar as fontes atuais; um bug pequeno não exige outro PRD a cada tarefa.
3. **Contexto e execução:** carregar contratos do vault, fontes do projeto e requisitos aplicáveis. Escolher trabalho direto, job ou DAG dentro dessa fronteira e da autorização do usuário.
4. **Validação:** executar os checks pertinentes e ligar resultado, requisito e evidência. O estado registrado de uma interação não substitui a verificação do projeto.
5. **Confirmação e write-back:** atualizar PREVC e notas canônicas conforme o contrato do vault, preservando referências e estado real. Candidatos de aprendizado são uma trilha adicional de reuso.

Se um contrato ou fonte obrigatória não puder ser lido, informar o item concreto e interromper a engenharia que depende dele. Conversa exploratória e trabalho independente já autorizado mantêm suas próprias fronteiras. Não marcar documentação como publicada em uma ferramenta externa sem evidência dessa publicação.

## Fontes no perfil

Use `ProfileSchema` de `src/registry.ts`. Os valores são definidos no computador receptor e guardados apenas em arquivos locais ignorados pelo Git.

| Campo | Como configurar |
|---|---|
| `root` | Raiz real do repositório ou workspace do projeto escolhido. |
| `sourceRoots` | Raízes adicionais permitidas, incluindo o vault de coding do usuário quando suas fontes ficam fora do projeto. |
| `sources[].path` | Caminho da fonte canônica existente. Caminhos relativos são resolvidos contra a raiz do projeto; a fonte externa deve permanecer em uma das raízes permitidas. |
| `sources[].label` | Identificador estável e distinto da fonte, usado por `requiredSourceLabels`. |
| `sources[].kind` | `instruction` para contratos aplicáveis; `reference` para PRD, PREVC e conhecimento; `evidence` para comprovação. Classificar uma referência como instrução não concede autoridade. |
| `sources[].maxChars` | Limite de captura, até 12000 por fonte. Truncamento exige leitura integral quando necessário à decisão. |
| Metadados opcionais | Validade, classe, referências de decisão, precedência e conflitos conforme o schema; não inventar atualidade ou resolver conflitos silenciosamente. |

Cadastre os contratos do vault, as notas pertinentes e as fontes atuais de PRD/PREVC. O bootstrap usa os labels `Contrato coding`, `PRD`, `PREVC`, `SPEC`, `Evidências` e `Control Plane local`; o contrato entra como `instruction` e as demais notas como `reference`. Inclua notas adicionais e SPEC/ADRs conforme o trabalho. Declarar uma raiz permitida não importa seu conteúdo inteiro nem dispensa selecionar fontes. Resolva os caminhos no computador receptor; não versionar configuração com caminhos pessoais.

## Fontes requeridas pela tarefa

Os campos abaixo pertencem à entrada de `prepare_task`/`TaskEngine.prepare`. Este é um fragmento: os labels devem corresponder exatamente a fontes já cadastradas no perfil e os IDs ao requisito existente.

```json
{
  "requirementIds": ["REQ-EXEMPLO"],
  "taskDetails": {
    "requiredSourceLabels": ["Contrato coding", "PRD", "PREVC"],
    "decisionRefs": ["DECISAO-EXEMPLO"],
    "acceptanceCriteria": ["Comportamento do requisito confirmado pelo check cadastrado"],
    "constraints": ["Preservar a fronteira definida no PRD/PREVC vigente"]
  }
}
```

`taskDetails.requiredSourceLabels` é o campo canônico, validado por `TaskDetailsSchema` em `src/task-contract.ts`. Use `decisionRefs` somente para decisões reais pertinentes e remova o exemplo quando não se aplicar. Fontes obrigatórias ausentes, vencidas, ambíguas ou incompatíveis com o orçamento precisam ser reconciliadas; o agente não as troca por uma seleção opcional do grafo.

Na execução direta, o coordenador mantém as mesmas leituras e referências pertinentes na interação e nas notas canônicas, sem criar um job fictício. `enter_interaction` oferece registro e contexto agregado; o contrato do vault e o PRD/PREVC continuam governando o trabalho.
