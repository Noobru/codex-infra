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
   continuidade, política e contexto agregado. `productDispatch:false` preserva a
   seleção sem objetivo; entrada persistente de trabalho pode iniciar manutenção
   de aprendizado pela política permanente já autorizada, com limites próprios.
   Confira `runtime.restartRequired` quando presente: processo desatualizado exige
   recarregar o MCP ou usar a CLI compilada atual antes de gravar novos campos.
   A versão do plugin instalada sozinha não prova que um MCP já aberto recarregou.
3. Pedido explícito de nenhuma gravação usa `persist:false`; não escreva arquivo
   de input na CLI. Um registro existente continua consultável. Em próximos turnos
   reuse o ID e a revisão; `interaction_status` consulta sem criar nova tarefa.
4. Antes de trabalho novo na mesma conversa, atualize objetivo/intent/route com
   `record_interaction` e `expectedRevision`. Vincule `jobIds`/`workflowIds` somente
   depois de preparados. Não prepare job fictício para registrar trabalho direto.
5. Ao concluir ou bloquear uma etapa material, registre status, resumo breve,
   fontes/evidências e correções. Não grave mensagem por mensagem ou transcrição.
   Importado significa apenas continuidade disponível, nunca job pronto/concluído.

Ao registrar um resultado material, avalie se houve correção ou prática reutilizável.
Se houver, inclua `findings` em `record_interaction`: cada item tem `id` estável,
`projectId` explícito, `title`, `kind` (`practice`, `skill` ou `script`), `content`
e `evidence` (referências reais). O fluxo cria o candidato automaticamente e retorna
`findingProcessing`; confira seus warnings. `reconcile_interaction_findings` retoma
processamento pendente sem duplicar propostas nem mudar a revisão de origem.
Sem achado sustentado, não fabrique conteúdo para preencher a fila. Uma falha
isolada é sinal para investigar, não prova de uma prática. Propostas manuais por
`propose_learning` continuam disponíveis. Sob a política permanente do owner,
achados e padrões sustentados de retrabalho seguem construção, revisão independente,
teste isolado e ativação automática; confira o caso e o hash em `learning_cycle_status`.
Informe a melhoria e seu hash para o owner desativar quando desejar; não peça nova
aprovação por promoção. Isto não instala interceptador de mensagens no aplicativo.
Detalhes: `docs/AUTONOMOUS-LEARNING.md` e `INTERACTIONS.md`.

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

## Qualificar e delegar pelo Infra

O próprio orquestrador qualifica cada tarefa antes de criar um worker. Não peça ao
owner para escolher categoria, modelo ou esforço; não use regex do título nem outro
LLM apenas para classificar. Considere o objetivo, fontes, limites, incerteza e aceite
observados. Use ferramentas diretamente para buscas ou checks determinísticos.

Quando houver benefício concreto em delegar, use `delegate_task({input:{project,
objective,idempotencyKey,mode,checkIds,taskDetails,qualification}})`. A qualificação
deve conter `taskClass` (`retrieval`, `implementation`, `research`, `review` ou
`defensive-security`), `complexity`, `uncertainty`, `risk` e `contextCoupling`
(`low`, `moderate`, `high`), `bounded`, `independentlyVerifiable`,
`delegationBenefit` (`unknown`, `expected`, `observed`) e uma `rationale` curta
com a evidência da avaliação. Categoria sozinha não basta. Retrieval significa
seleção/extração delimitada de fontes; síntese com incerteza exige análise.

A configuração retornada por `enter_interaction.modelRouting` vem de
`profiles/model-routing.json`: retrieval simples Luna/low; implementação simples
Luna/medium; análise simples Sol/medium e moderada Sol/high; tarefa complexa,
arriscada, acoplada ou sem benefício de delegação permanece com o coordenador
configurado (inicialmente Astra/ultra). Nesse caso, continue no coordenador atual;
não crie outro Ultra apenas para duplicá-lo. Daybreak Blue segue o contrato global.
Os campos `explicitRequestedModel` e `explicitRequestedReasoningEffort` representam
somente uma escolha expressa do owner, nunca herança implícita do modelo desta sessão.

`delegate_task` seleciona a rota, fixa a política e executa pelo TaskEngine canônico.
Delegações comuns têm rede disponível por padrão, inclusive revisão `read-only`.
O contrato registra `taskDetails.networkAccess:true`; não exigir que o owner peça
rede para cada subagente. Descreva as ações permitidas no objetivo e selecione o
modo de escrita conforme o trabalho, independentemente da necessidade de rede.
Não confunda revisão sem alterações com proibição de rede, nem faça consultas no
coordenador só para compensar uma permissão ausente. Use `networkAccess:false`
quando a tarefa for explicitamente offline; workers de aprendizado local conservam
seu isolamento próprio. O campo fica no contrato/hash e não autoriza publicação.
Quando a tarefa precisar do GitHub privado já autorizado, use
`taskDetails.gitHubAuth:true`: o runtime reutiliza o login existente do `gh`
somente no ambiente do processo filho. Não imprimir, copiar para arquivos nem
pedir ao owner que envie tokens. O recibo registra o mecanismo, não a credencial.
Após mudança do schema/build, MCP antigo deve usar a CLI compilada atual até ser
recarregado; não afirmar que uma permissão foi aplicada sem recibo do runtime.
Não exige um `route_task` anterior: esse comando é apenas preview. Antes do turno,
o worker confere o catálogo e os valores efetivos; indisponibilidade bloqueia sem
escalada automática para Ultra. Confira `execution`, `routingDecision` e artefatos
retornados, valide o resultado e integre a evidência à tarefa principal.

Após integrar o resultado ou a falha e encerrar o uso do worker, chame
`finish_delegation({jobId,input:{expectedAttempt,threadId,integrated:true,author,source,evidence}})`.
Use a tentativa e a thread reais do recibo. A CLI equivalente é
`finish-delegation JOB_ID --file DECISION.json`. O núcleo recusa worker ativo e
arquiva pelo app-server oficial; confira `status:archived`. `pending` preserva a
evidência e exige retomar essa finalização. Não arquive tarefa humana nem apague
recibos. O construtor de aprendizado finaliza seus dois workers depois de salvar
o resultado integrado; delegações comuns são finalizadas pelo coordenador.

Para fila/DAG, `prepare_task` e cada task de `prepare_workflow` recebem essa mesma
qualificação em `routing`; `run_task`/workflow executam o contrato salvo. Novos jobs
de modelo sem qualificação completa são rejeitados. Jobs antigos sem política
fixada preservam o histórico e exigem nova preparação antes de executar.

Este é o caminho governado de criação de agentes do Infra. Não substitua a delegação
por `collaboration.spawn_agent` nativo: o Infra não intercepta essa chamada nem pode
provar seus parâmetros. Detalhes e limites: `docs/MODEL-ROUTING.md`.

## Contexto e execução

`task_context` prevê o contexto sem criar job/modelo; pode persistir captura derivada. Grafo e conhecimento promovido entram automaticamente em task-context/prepare/run. Não chamar `knowledge_index`/`knowledge_search` antes de toda tarefa: use-os para inspeção/consulta deliberada.

Preserve taxonomia dos vaults, fonte/hash/validade, exclusões, precedência/conflitos e truncamento. Decisões ativas e fontes obrigatórias orientam seleção. Referência não vira autoridade; leia conteúdo completo quando necessário. O CapabilityPlanner identifica capacidades/gates; uma decisão sobre publicação não bloqueia execução independente autorizada.

Use `prepare_task` com objetivo, projeto, modo, kind, checks e chave idempotente daquela solicitação. `kind: checks` executa checks registrados; `kind: codex` usa worker e seus checks. Escrita exige modo permitido e objetivo autorizado. Worktrees requerem baseRef local explícito, fixado em SHA na preparação; não incorporam resultado automaticamente à árvore original.

Se esta skill estiver dentro de um worker CodexInfra, cumpra o objetivo recebido; não prepare outro worker recursivo.

## Workflow e concorrência

Use DAG quando partes independentes ou dependências justificarem. `prepare_workflow` recebe objetivo, chave, nós com task/dependsOn e maxRevisions; valide o plano contra o pedido. `run_workflow` aguarda; `start_workflow` usa supervisor limitado. Preparação não executa; drafts interrompidos não despacham. Repetir solicitação idêntica retoma a preparação.

Leia `execution_policy`: configuração inicial 2 workers/1 modelo, até quatro configuráveis enquanto ociosos. Não elevar limites sem decisão correspondente. Recursos sobrepostos são exclusivos; worktrees independentes permitem paralelismo. Uma chamada não supera o limite global.

O workflow executa apenas seus jobs e entrega checks/hash das dependências concluídas ao próximo nó. Em falha, leia evidência e use `replan_workflow` com motivo, evidência e substituições. Preserve concluídos, projeto/modo e maxRevisions; executar a nova revisão é ação explícita. Não replanejar em loop para contornar uma restrição.

Para fila preparada fora de DAG, limitar `drain_queue`/`start_queue` por jobIds, quantidade e duração. Guardar ID de supervisor e acompanhar `queue_status`; `stop_queue` solicita parada. Não despachar novos objetivos de produtos por iniciativa própria. A manutenção de aprendizado autorizada usa o mesmo supervisor e os limites compartilhados, acionada por atividade e resultados materiais; consultas não iniciam esse ciclo.

## Aprendizado e segurança

### Docker Desktop no Windows

Antes de abrir Docker para validação autorizada, use `inspect_docker_recovery`
(CLI `docker-recovery`) para detectar sockets órfãos conhecidos. Se houver o erro
de socket inacessível e nenhum processo ativo, use `recover_docker_start` apenas
com a autorização explícita já recebida para recuperar/iniciar. O fluxo preserva
as pastas de sockets e não apaga dados. Confirme `healthy:true` em nova inspeção;
lançamento não comprova funcionamento. Não repetir abertura ou limpeza em loop.
Consulte `docs/DOCKER-RECOVERY.md`. A manutenção de aprendizado e o
sandbox não ganham autorização para iniciar ou encerrar Docker/WSL.

Declare `performanceScope` (taskClass, language e problemCategory quando pertinentes)
na entrada/atualização da interação e nos taskDetails do job, antes do trabalho ao
qual se aplica. Use classes estáveis e compatíveis; não deduza escopo histórico
pelo título nem transforme um exemplo em projeto selecionado. O escopo orienta
comparações de tarefas semelhantes no Efficiency.

Com a telemetria local habilitada, entrada persistida e record reconciliam os
contadores das conversas já entradas; `persist:false` não captura nada.
`capture_interaction_telemetry` captura a conversa explícita; o turno corrente fica
parcial até a conclusão observada, normalmente reconciliada na interação seguinte.
`read_efficiency_history` consulta séries diárias, marcos e efeitos registrados.
Os recibos preservam contadores e proveniência, sem transcrições. Não somar
snapshots cumulativos nem convertê-los em cota ou dinheiro.

Ao registrar finding reutilizável, inclua `impact` com problema, linguagem,
mudança esperada e baselines/checks afetados quando houver evidência. Uma capacidade
ativa pertinente ao objetivo deve ser usada por `run_learning_capability({hash,input})`,
com hash completo, projectId exato, entrypoint e dados conforme o descriptor. Acrescente
`input.attribution:{threadId,turnId}` quando as identidades reais forem conhecidas.
Também pode fornecer `input.threadId` do próprio caller para capturar o turno
atual explicitamente registrado; o runtime recusa identidade ambígua ou projeto
diferente. Nunca use a identidade do processo MCP como se fosse a do caller.
O runtime já registra a execução e os outputs; não invente aplicação nem economia de
tokens. Use os outputs apenas dentro do trabalho autorizado. Se o owner fornecer um
hash para desativar, chame `disable_learning_capability` com a decisão real dele.

Para releases da API manual aplicadas no trabalho direto, `record_learning_application`
continua disponível com candidateId, threadId, turnId e evidência concreta. Obtenha
a identidade do turno por telemetria quando necessário. Inclusão no Context Pack,
aplicação declarada e execução real de capacidade permanecem evidências distintas.

A conclusão de uma tentativa com checks produz automaticamente uma avaliação e
o recibo `attempt-N/insights.json`. Confira esse processamento junto dos checks;
warnings requerem correção/reconciliação, não mudança do resultado original.
`reconcile_insights` importa checks históricos do projeto explícito, sem executar
comandos; `read_insights` e Efficiency apresentam comparações compatíveis e sinais
de falha/recuperação. `record_evaluation` continua disponível para métricas e
avaliações adicionais observadas. Métrica desconhecida permanece desconhecida;
aceite do owner exige declaração dele. Não atribuir consumo da conversa coordenadora
a um job de checks sem worker de modelo.

O ciclo automático gera bundles versionados com entrypoints Node/Python, testes e
SKILL.md quando aplicável. Dois jobs separados fazem síntese e revisão do hash exato;
os checks dessas etapas validam JSON, sem executar o código gerado. O runtime testa
em workspace próprio usando Docker já ativo, imagens locais fixadas e rede desabilitada.
Não iniciar Docker/WSL, baixar imagens ou instalar dependências para contornar ausência
do ambiente. O Codex continua nativo no Windows. A ativação usa author.role:model e
referencia a política permanente do owner; nunca se apresente como owner.

Na API manual preservada, `learning_shadow_source` e `validate_learning` ligam
proposta, tentativa e avaliação; `promote_learning` exige a decisão explícita do
owner e `revert_learning` preserva o histórico. Esse caminho não é um requisito
extra para cada ativação do ciclo automático. Nenhum caminho instala skills globais.

`security_report` consome relatório existente do projeto explícito e persiste gate. Feeds OSV/KEV são opcionais por solicitação `feeds.mode: enrich`, com findings concretos. Publisher GitHub incluído usa dry-run por padrão; envio real exige configuração e autoridade exata/fresca por projeto, destino, SHA e estágio. Não inferir aplicabilidade por parecer de modelo, nem executar scan/patch/deploy por essa tool.

## Retomar e concluir

`task_status` e `workflow_status` mostram evidências duráveis. Timeout do cliente não confirma parada; cancelamento retém owner até cleanup. Um coordenador sem claim não cancela tentativa alheia. `reconcile_tasks` estaciona owners ausentes sem repetir ações; retry é explícito após revisar causa/arquivos. Cleanup desconhecido exige inspeção real antes de `confirm_processes_stopped`.

Conclua com resultado, verificação, estado e checkpoint. Aceite da infraestrutura usa fixtures próprias pequenas; produtos citados como exemplo não são alvos. Cadastro restaurado não autoriza execução antes da ativação seletiva. Preserve autorizações próprias de publicação, push, merge, deploy e políticas globais.

Consulte `docs/USO.md`, `docs/USO.md`, `docs/USO.md`, `AUTONOMOUS-LEARNING.md` e `docs/USO.md` para schemas/sequências. Se o MCP estiver ausente, use a mesma CLI:

~~~powershell
node dist/src/cli.js context --project codex-infra
~~~

Build, perfil ou dependência ausentes devem ser informados concretamente; não simule ferramentas ou validação.
