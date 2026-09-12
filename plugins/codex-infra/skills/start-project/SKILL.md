---
name: start-project
description: Entrada operacional do CodexInfra para conversas novas ou retomadas, consultas, trabalho direto e projetos com jobs ou workflows. Preserva identidade, contexto, evidências e aprendizado. Adotada como entrada padrão quando configurada no contrato global; exemplos não selecionam projetos e seleção sem objetivo só autoriza leitura.
---

# Entrar e trabalhar pelo CodexInfra

Use o MCP `codex-infra`, servido por a instalação indicada em `docs/LOCAL-ADOPTION.md`. CLI/MCP compartilham registry, TaskEngine e StateStore. Não crie cadastro, fila ou executor paralelos.

## Entrada e continuidade

Após adoção no contrato global, esta é a entrada padrão para todas as tarefas locais.
Se já for worker/subagente coordenado, devolva o resultado ao coordenador sem criar
registro/worker recursivo. O restante se aplica à conversa coordenadora.

1. Obtenha `CODEX_THREAD_ID` no ambiente da própria tarefa. Use esse `threadId`,
   título real (ou nulo quando indisponível) e `source` com a referência do pedido.
   Não adivinhe identidade pelo inventário. Sem ID, use chave idempotente explícita
   e registre a limitação de vínculo ao Desktop.
2. Chame `enter_interaction({input:{interaction:{threadId,title,source,projectId,
   intent,route,objective}}})`. `projectId:null` para conversa geral. Intents:
   `conversation`, `project-context`, `work`; routes: `direct`, `job`, `workflow`.
   Projeto registrado é resolvido somente por escolha explícita. A chamada retorna
   continuidade, política e contexto agregado, sem iniciar execução.
3. Pedido explícito de nenhuma gravação usa `persist:false`; não escreva arquivo
   de input na CLI. Um registro existente continua consultável. Em próximos turnos
   reuse o ID e a revisão; `interaction_status` consulta sem criar nova tarefa.
4. Antes de trabalho novo na mesma conversa, atualize objetivo/intent/route com
   `record_interaction` e `expectedRevision`. Vincule `jobIds`/`workflowIds` somente
   depois de preparados. Não prepare job fictício para registrar trabalho direto.
5. Ao concluir ou bloquear uma etapa material, registre status, resumo breve,
   fontes/evidências e correções. Não grave mensagem por mensagem ou transcrição.
   Importado significa apenas continuidade disponível, nunca job pronto/concluído.

Uma correção reutilizável pode gerar `propose_learning` com
`origin:{interactionId,revision}`. Projeto nulo na origem permite destino explícito
na proposta, sem inferir aplicabilidade. Revisão, shadow e promoção continuam
obrigatórios. Instruções locais governam o agente; isto não instala interceptador
de mensagens no aplicativo. Detalhes: `docs/INTERACTIONS.md`.

## Vault, G-IDEIA e contrato do projeto

A infraestrutura opera sobre o vault de coding curado do usuário e seus contratos.
Ela não fornece nem substitui esse vault. Para engenharia, G-IDEIA continua sendo
o fluxo de formalização: conversa/descoberta → PRD e PREVC → contexto da tarefa →
execução/validação → confirmação e write-back. PRD define o que/por quê e os limites;
PREVC acompanha Planning, Review, Execution, Validation e Confirmation; SPEC/ADRs
definem o como quando aplicáveis. Notion e demais domínios seguem o contrato local.

Para adoção inicial autorizada, use `node scripts/Bootstrap-GIdeia.mjs --input
bootstrap.local.json` na instalação para inspecionar o plano sem escrever. O input
identifica `vaultPath` e opcionalmente `project` com id, name, code e root. `--apply`
aplica esse bootstrap: preserva contrato existente, complementa G-IDEIA quando
ausente e cria/vincula documentos locais. Inspecione conflitos antes de aplicar.
O módulo não cria um vault, aprova o PRD, configura checks reais ou publica no Notion.
Fontes existentes precisam ser lidas e reconciliadas; não substituir por templates.

Antes de implementar engenharia:

1. Leia os contratos do vault e do workspace. Localize os PRD/PREVC canônicos e o
   item/requisito pertinente; confira decisões vigentes e evidências do estado atual.
   Um pedido de conversa registrado por `enter_interaction` não é um PRD aprovado.
2. No perfil, registre as fontes reais do contrato de coding, PRD e PREVC com labels
   únicos, `sources` e `sourceRoots` permitidos. Não copie outro vault nem invente
   documentos a partir do título da tarefa. Não carregue o corpus inteiro.
3. Em `task_context`/`prepare_task`, inclua esses labels exatos em
   `taskDetails.requiredSourceLabels`; use `requirementIds`, `decisionRefs`, aceite,
   restrições e não objetivos correspondentes. O Context Pack bloqueia fonte
   obrigatória ausente/ambígua, inativa/expirada ou sem orçamento suficiente.
   Leia integralmente os trechos decisivos quando o pack indicar truncamento.
4. Em execução direta, confira as mesmas fontes e limites antes de editar; preserve
   referências no registro da interação. O registro não substitui esse trabalho.
5. Documento material ausente ou conflito de escopo bloqueia a implementação afetada.
   A conversa e o planejamento autorizado podem continuar para formalizar/atualizar
   pelo G-IDEIA antes da implementação. Não criar um PRD inteiro a cada bug: tarefas
   pequenas usam os artefatos existentes com profundidade proporcional.
6. Ao terminar, confronte aceite e evidências, atualize PREVC e faça o write-back
   exigido pelo vault. Um job concluído não fecha sozinho o PREVC do projeto.

As fixtures técnicas de validação da própria infraestrutura têm contrato de teste
delimitado; elas não autorizam dispensar o G-IDEIA em um projeto de engenharia.

## Resolver contexto e objetivo

1. Use o contexto de `enter_interaction` para o projeto explícito; `projects` ajuda a localizar o ID e `project_context` permite atualização deliberada. Leia contratos/checkpoints indicados e confira a fonte quando trechos não sustentarem a decisão.
2. Informe projeto resolvido, raiz, estado e próxima ação pertinente. Preserve objetivo e autorizações da conversa. Menção hipotética não seleciona projeto; “vamos trabalhar no projeto” sem objetivo só carrega contexto.
3. Com objetivo concreto, registre aceite, checks e restrições em `taskDetails`; inclua referências de decisão, capacidades e `openDecisions` materiais. Perfil não amplia autoridade nem troca o CWD do Desktop.
4. Escolha execução direta, tarefa persistente ou DAG conforme dependências, independência e necessidade de retomada. Não abra workers para duplicar trabalho já realizável nesta conversa.

O coordenador inicial escolhido é Astra Ultra ou o modelo forte selecionado futuramente pelo owner. Use a matriz de `route_task` para delegação delimitada; não há cadeia fixa. Daybreak Blue segue o contrato global de segurança defensiva. A disponibilidade real de modelo/esforço é conferida antes de gerar.

## Contexto e execução

`task_context` prevê o contexto sem criar job/modelo; pode persistir captura derivada. Grafo e conhecimento promovido entram automaticamente em task-context/prepare/run. Não chamar `knowledge_index`/`knowledge_search` antes de toda tarefa: use-os para inspeção/consulta deliberada.

Preserve taxonomia dos vaults, fonte/hash/validade, exclusões, precedência/conflitos e truncamento. Decisões ativas e fontes obrigatórias orientam seleção. Referência não vira autoridade; leia conteúdo completo quando necessário. O CapabilityPlanner identifica capacidades/gates; uma decisão sobre publicação não bloqueia execução independente autorizada.

Use `prepare_task` com objetivo, projeto, modo, kind, checks e chave idempotente daquela solicitação. `kind: checks` executa checks registrados; `kind: codex` usa worker e seus checks. Escrita exige modo permitido e objetivo autorizado. Worktrees requerem baseRef local explícito, fixado em SHA na preparação; não incorporam resultado automaticamente à árvore original.

Se esta skill estiver dentro de um worker CodexInfra, cumpra o objetivo recebido; não prepare outro worker recursivo.

## Workflow e concorrência

Use DAG quando partes independentes ou dependências justificarem. `prepare_workflow` recebe objetivo, chave, nós com task/dependsOn e maxRevisions; valide o plano contra o pedido. `run_workflow` aguarda; `start_workflow` usa supervisor limitado. Preparação não executa; drafts interrompidos não despacham. Repetir solicitação idêntica retoma a preparação.

Leia `execution_policy`: configuração inicial 2 workers/1 modelo, até quatro configuráveis enquanto ociosos. Não elevar limites sem decisão correspondente. Recursos sobrepostos são exclusivos; worktrees independentes permitem paralelismo. Uma chamada não supera o limite global.

O workflow executa apenas seus jobs e entrega checks/hash das dependências concluídas ao próximo nó. Em falha, leia evidência e use `replan_workflow` com motivo, evidência e substituições. Preserve concluídos, projeto/modo e maxRevisions; executar a nova revisão é ação explícita. Não replanejar em loop para contornar uma restrição.

Para fila preparada fora de DAG, limitar `drain_queue`/`start_queue` por jobIds, quantidade e duração. Guardar ID de supervisor e acompanhar `queue_status`; `stop_queue` solicita parada. Não há autostart ou novos objetivos automáticos.

## Aprendizado e segurança

Registre `record_evaluation` a partir de tentativa/checks reais. Métrica desconhecida permanece desconhecida; aceite do owner exige declaração dele.

Quando houver conteúdo reutilizável, `propose_learning` vincula a proposta à tentativa; `review_learning` registra revisão. Obtenha `learning_shadow_source`, use seu descriptor exato numa tarefa pequena autorizada, execute e registre avaliação; `validate_learning` liga conteúdo/tentativa/avaliação. Só `promote_learning` com decisão explícita documentada do owner ativa contexto futuro; `revert_learning` desfaz seleção preservando histórico. Não instala skill global nem executa script automaticamente.

`security_report` consome relatório existente do projeto explícito e persiste gate. Feeds OSV/KEV são opcionais por solicitação `feeds.mode: enrich`, com findings concretos. Publisher GitHub incluído usa dry-run por padrão; envio real exige configuração e autoridade exata/fresca por projeto, destino, SHA e estágio. Não inferir aplicabilidade por parecer de modelo, nem executar scan/patch/deploy por essa tool.

## Retomar e concluir

`task_status` e `workflow_status` mostram evidências duráveis. Timeout do cliente não confirma parada; cancelamento retém owner até cleanup. Um coordenador sem claim não cancela tentativa alheia. `reconcile_tasks` estaciona owners ausentes sem repetir ações; retry é explícito após revisar causa/arquivos. Cleanup desconhecido exige inspeção real antes de `confirm_processes_stopped`.

Conclua com resultado, verificação, estado e checkpoint. Aceite da infraestrutura usa fixtures próprias pequenas; produtos citados como exemplo não são alvos. Cadastro restaurado não autoriza execução antes da ativação seletiva. Preserve autorizações próprias de publicação, push, merge, deploy e políticas globais.

Consulte `docs/USO.md`, `docs/USO.md`, `docs/USO.md` e `docs/USO.md` para schemas/sequências. Se o MCP estiver ausente, use a mesma CLI:

~~~powershell
node dist/src/cli.js context --project codex-infra
~~~

Build, perfil ou dependência ausentes devem ser informados concretamente; não simule ferramentas ou validação.
