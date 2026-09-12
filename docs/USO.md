# Instalação e operação

## Configuração

Execute os comandos de instalação do README dentro da cópia clonada. `Configure-Local.mjs` usa o `TaskEngine`, o `ProfileManager` e a política canônica para cadastrar somente `codex-infra`. A configuração contém caminhos desta instalação e fica fora do Git. Repetir configuração idêntica é seguro; definição existente diferente exige revisão explícita, não substituição silenciosa.

O bootstrap não cadastra nem valida o vault do usuário. Antes de engenharia, carregar os contratos do vault de coding equivalente e conectar as fontes canônicas de PRD/PREVC é obrigatório. [Contrato de contexto](CONTEXT-CONTRACT.md) define essa compatibilidade e explica o cadastro; `doctor` verde não substitui a leitura dessas fontes.

O plugin pessoal usa o identificador `codex-infra`. O instalador requer os helpers `plugin-creator` presentes no Codex e Python 3; parâmetros `-PluginCreatorRoot` e `-PythonPath` permitem indicar instalações existentes. Para atualização já instalada, use `-Update`. O instalador preserva marketplaces e destinos diferentes, valida caminhos e registra um recibo local.

Se configurar MCP manualmente, use o objeto gerado em `plugins/codex-infra/.mcp.json`. Ele inicia `dist/src/mcp.js` com o Node local e `CODEX_INFRA_ROOT` correspondente. Não publique esse arquivo gerado. A autenticação com Codex pertence ao usuário: use o login do cliente ou `node node_modules/@openai/codex/bin/codex.js login`. O setup não cria chave de API nem migra autenticação.

## Bootstrap G-IDEIA

O módulo complementar confere o vault informado e prepara a adoção do método preservando regras existentes. Use `bootstrap.local.json` conforme [Contrato de contexto](CONTEXT-CONTRACT.md). O arquivo contém configuração pessoal e permanece fora do Git.

```powershell
node scripts/Bootstrap-GIdeia.mjs --input bootstrap.local.json
node scripts/Bootstrap-GIdeia.mjs --input bootstrap.local.json --apply
```

Sem `--apply`, a operação produz preview de metadados, sem gravação, checks ou modelo. Com `--apply`, instala o contrato complementar quando necessário, preserva backup das instruções alteradas e pode preparar índice, PRD, PREVC, SPEC e Evidências do projeto. Artefatos existentes divergentes exigem reconciliação; não são sobrescritos para fazer caber um template.

O parâmetro `project` é opcional. Sem ele, o escopo é a adoção do contrato no vault existente. Com ele, o cadastro usa o gerenciador canônico e liga as fontes do projeto. O perfil novo inicia com `checks: []`: cadastre os checks reais, complete e revise os documentos conforme o discovery e o pedido antes da execução. Não se cria nem se publica página no Notion por esse script; quando a sincronização é exigida pelo contrato, o agente a executa e verifica pelo conector autorizado.

## Cadastrar um projeto

Peça ao agente para produzir o perfil de acordo com `ProfileSchema` em `src/registry.ts`, após ler os contratos do vault e localizar o PRD/PREVC existente. Revise ID/aliases, raiz existente, estado, modos, fontes, checks e workspaces. Cadastre o vault em `sourceRoots` e seus contratos/notas pertinentes em `sources`; os labels identificam as fontes requeridas pela tarefa. Cada check tem executável, argumentos, diretório relativo e declaração `readOnly` compatível com seu efeito real. Fontes adicionais exigem raízes permitidas explícitas.

```powershell
node dist/src/cli.js register --file profile.local.json
node dist/src/cli.js projects
node dist/src/cli.js context --project projeto-exemplo
```

Não versionar `profile.local.json`. Cadastro não executa os comandos do projeto nem instala seu ambiente. Produtos pausados conservam seus limites.

## Preparar e executar

Uma entrada de tarefa contém `project`, `objective`, `idempotencyKey`, `mode`, `kind` e `checkIds`. Inclua os vínculos pertinentes em `requirementIds` e as fontes obrigatórias em `taskDetails.requiredSourceLabels`, junto de critérios de aceite, restrições e decisões. Use uma chave estável para a mesma solicitação e uma nova chave para outro contrato. O exemplo de [Contrato de contexto](CONTEXT-CONTRACT.md) usa os nomes reais dos campos do schema.

Antes de preparar job ou DAG, cumpra o G-IDEIA aplicável. Ideia nova exige formalização proporcional após conversa/discovery; tarefa de projeto existente usa e atualiza PRD/PREVC canônicos. Trabalho direto tem a mesma obrigação documental proporcional. Registrar uma interação ou preencher `taskDetails` não substitui PRD/PREVC.

```powershell
node dist/src/cli.js task-context --file task.local.json
node dist/src/cli.js prepare --file task.local.json
node dist/src/cli.js run JOB_ID --timeout 300000
node dist/src/cli.js status JOB_ID
```

`kind: checks` executa checks cadastrados. `kind: codex` usa um worker e depois os checks; consome o acesso da conta. `workspace: worktree` exige `baseRef` local explícito, fixado em SHA na preparação. Mudança de arquivo exige modo permitido e autorização da tarefa.

## Concorrência e workflows

O bootstrap aplica 2 workers, até 1 de modelo. Consulte `execution-policy`; alterações exigem workers ociosos. Há limite de até quatro workers e o limite de modelo não supera o total. Raízes iguais ou sobrepostas disputam o mesmo recurso. Worktrees distintas permitem trabalho independente.

`WorkflowInputSchema` em `src/workflow.ts` define objetivo, chave, nós `id`/`dependsOn`/`task` e limite de revisões. O agente usa `prepare_workflow` e `run_workflow` ou `start_workflow`. Preparar não executa. Cada plano despacha apenas seus jobs e repassa evidências das dependências. Uma falha exige diagnóstico e revisão explícita; nós concluídos são preservados.

Para fila sem DAG, selecione IDs e limites deliberadamente:

```powershell
node dist/src/cli.js start-queue --jobs JOB_1,JOB_2 --max-jobs 2 --concurrency 2 --timeout 300000
node dist/src/cli.js queue-status SUPERVISOR_ID
node dist/src/cli.js stop-queue SUPERVISOR_ID
```

O supervisor é temporário, oculto e limitado. Não há reinício automático nem novos objetivos criados por ele.

## Falha e retomada

Consulte status, tentativas e artefatos antes de retry. `cancel JOB_ID` solicita parada; timeout do cliente não comprova encerramento. `reconcile` identifica owners ausentes e estaciona trabalho para revisão. `retry` é explícito e preserva tentativas anteriores. Cleanup desconhecido exige inspeção real antes de liberar o recurso.

## Contexto e aprendizado

Contexto atual, conhecimento promovido e grafo entram no caminho canônico de preview/prepare/run. Não é necessário indexar manualmente antes de cada tarefa. Fontes obrigatórias, validade, precedência, conflito, orçamento e truncamento permanecem explícitos. Referência não ganha autoridade por entrar no contexto.

O [ciclo de aprendizado executável](AUTONOMOUS-LEARNING.md) recebe achados e retrabalho observado, gera o bundle em um job, revisa a cópia exata em outro, executa testes isolados e ativa a melhoria pela política permanente do owner. O painel informa o hash para uso e desativação. `run_learning_capability` recebe inputs num workspace próprio e devolve outputs com receipt; não instala scripts globais. As APIs manuais de shadow, `promote_learning` e `revert_learning` preservam seus gates anteriores. O aprendizado complementa o write-back do projeto e a confirmação do PREVC.

Na sua instalação, registre a decisão permanente real do owner em `learning-policy.local.json` e use `node dist/src/cli.js learning-policy --file learning-policy.local.json`. Consulte sem `--file` para apenas ler. O guia canônico contém o schema, os limites e a seleção de projetos; o pacote não traz uma autorização de outra pessoa. A manutenção compartilha os limites do `TaskEngine` e pode começar em novas entradas de trabalho e resultados materiais. A entrada não despacha jobs do produto.

O Codex continua nativo no Windows, sem exigir WSL. Para testar e chamar capacidades geradas, disponibilize um Docker já ativo e as imagens locais aceitas pelo adaptador. Ele fixa o ID da imagem, bloqueia a rede e monta somente o workspace próprio; não inicia Docker/WSL, não faz pull e não instala dependências.

Resultados materiais registrados por `record_interaction` podem incluir `findings` explícitos. Cada achado sustentado gera um candidato com ID estável, evidência e revisão de origem; updates/replays repetidos não criam duplicatas. O retorno `findingProcessing` mostra candidatos e warnings. Se a gravação da interação passar e o processamento falhar, corrija a causa e use `reconcile_interaction_findings({id})` ou `node dist/src/cli.js interaction-findings INTERACTION_ID`. O replay conserva a revisão. [Interações e continuidade](INTERACTIONS.md) contém o JSON exato e os limites; ausência de achado não deve ser preenchida com uma prática inventada.

## Avaliações e comparações automáticas

Ao finalizar uma tentativa com checks, o motor processa os receipts reais e grava avaliações sem uma nova chamada de modelo. O recibo `artifacts/jobs/<jobId>/attempt-N/insights.json` registra avaliações e warnings. Uma falha dessa etapa preserva o resultado original do job. Dados insuficientes, checks truncados e tentativas ainda em execução não viram avaliação verde.

Para histórico anterior à atualização, ou para repetir o processamento de evidência já existente:

```powershell
node dist/src/cli.js insights-reconcile --project projeto-exemplo --max-jobs 50
```

Substitua o projeto pelo ID explícito registrado. O comando lê receipts locais e grava avaliações idempotentes; não executa checks nem abre diretórios de produtos. MCP equivalente: `reconcile_insights({projectId:"projeto-exemplo",limit:50})`. O limite aceita 1–100, padrão 50; confira `warnings` e `truncated`. `read_insights({projectId:"projeto-exemplo",limit:50})` apenas consulta. A tela Efficiency apresenta as comparações automaticamente; a escolha manual continua disponível.

A comparação usa o receipt anterior compatível de checks aprovados, ordenado pela janela medida. Projeto, contrato, rubrica, métrica, unidade, método, versão e coorte precisam coincidir. Durações de checks são medidas em `ms`, com identidade do comando na coorte. Falha seguida de recuperação e falha repetida são sinais separados, com links para evidência. Os resultados são descritivos: uma amostra não prova ganho causal nem economia da assinatura. Sem pares compatíveis, nenhuma comparação é fabricada; aceite do owner continua separado. Avaliações manuais com `record_evaluation` continuam disponíveis.

## Efeito das melhorias ao longo das semanas

Efficiency começa pelo problema e pela melhoria: erro de sintaxe confirmado → capacidade de prevenção → revisão e testes → ativação → execução e resultados comparáveis. O agente declara o problema/linguagem e a mudança esperada em `findings[].impact`, ligando baselines/checks reais quando disponíveis. Invocações preservam hash, resultado, duração e timestamps; `attribution` liga o turno conhecido. O histórico de tokens mantém projeto/classe/linguagem e contadores completos; a execução não vira economia estimada. Veja os formatos em [Interações](INTERACTIONS.md).

O painel relaciona candidatos, promoção/reversão, inclusão por caminho/hash no Context Pack e avaliações compatíveis. Falhas e novas tentativas são contagens observadas; não equivalem automaticamente a erro de sintaxe ou retrabalho humano. Inclusão de conteúdo não prova aplicação correta nem causa da diferença. Ausência de baseline, uso avaliado ou medidas pertinentes aparece como próxima evidência necessária.

```powershell
node dist/src/cli.js efficiency-history --project projeto-exemplo --days 14
```

MCP: `read_efficiency_history({input:{projectId:"projeto-exemplo",days:14}})`. A consulta retorna `{history,improvements}`, sem execução ou captura. Períodos aceitos: 7, 14, 30 e 90 dias, padrão 14. No gráfico, selecione fonte, métrica e coorte. Tokens medidos, jobs Codex, checks e ciclos de trabalho direto declarado ficam separados, com unidade/amostra e detalhes acessíveis. Duração de check é apoio à análise, não um score de qualidade. Lacunas não viram zero nem projeção futura; deltas entre dias são descritivos.

## Telemetria local opcional

A coleta de tokens do coordenador fica desativada sem `profiles/telemetry.local.json`. Para optar por ela, salve nesse arquivo um objeto JSON com o único campo `sessionsRoot`, contendo o caminho absoluto real da pasta `sessions` do Codex deste usuário. Resolva a pasta a partir de `CODEX_HOME` quando configurado; caso contrário, confira a pasta `.codex` do usuário. Preserve e revise qualquer configuração local já existente. O arquivo permanece ignorado pelo Git e fora da distribuição.

O coletor procura apenas o rollout correspondente à identidade UUID de uma tarefa explicitamente entrada localmente e confirma sua identidade. Importação de metadados não ativa a leitura. Dos eventos locais ele deriva recibos com contadores, datas, IDs, revisão/escopo de origem e fingerprint/cursor; **não guarda nem exporta mensagens, prompts, respostas, chamadas de ferramenta ou transcrições**. O caminho da sessão também não entra no recibo. O estado derivado continua privado.

Com essa configuração, `enter_interaction` persistente e `record_interaction` reconciliam até dez interações locais recentes, retornando um resumo `telemetry`. Uma entrada com `persist:false` não coleta. O turno em andamento pode permanecer parcial até uma próxima entrada/gravação observar seu término; não existe daemon. Para captura ou replay explícitos:

```powershell
node dist/src/cli.js telemetry-capture THREAD_UUID
node dist/src/cli.js telemetry-reconcile --max-jobs 10
node dist/src/cli.js telemetry-read --project projeto-exemplo --days 14
```

Substitua `THREAD_UUID` pelo UUID real da tarefa registrada. Apesar do nome da flag, `--max-jobs` limita **interações** recentes, de 1 a 10, padrão 10; não inicia jobs. MCP equivalente: `capture_interaction_telemetry({threadId})`, `reconcile_interaction_telemetry({limit:10})` e `read_interaction_telemetry({projectId:"projeto-exemplo",days:14})`. Leitura aceita 1–90 dias pela interface MCP e usa apenas recibos, sem consultar os rollouts. O dashboard também só lê a projeção já gravada.

Os recibos ficam em `artifacts/telemetry/<interactionId>/turn-<turnId>.json`; um turno incompleto usa `.partial.json`. Status `complete`, `partial` e `unknown`, cobertura e warnings preservam limitações. A medição subtrai o snapshot anterior ao início do turno; duplicatas não somam novamente. Sem baseline, com reset de contador, sem término observado ou ao atingir limites de leitura, uso cumulativo não vira consumo completo daquele turno. Recibos completos são imutáveis.

O gráfico usa somente turnos completos com projeto e `performanceScope` registrados na revisão vigente ao iniciar o turno. N é específico de cada contador: total, input, cache-read, output, reasoning e cache-write só aparecem quando observados; input sem cache é derivado de input/cache válidos. Campos ausentes continuam sem amostra. A média por turno divide pela amostra correspondente; o total diário também varia com volume. Contadores cumulativos de workers ficam separados e não entram nessa soma. Esses números não medem preço, cota da assinatura ou consumo causado por uma skill/erro particular.

Para vincular a aplicação declarada de uma melhoria promovida ao turno observado, prepare `application.local.json` com `candidateId`, `threadId`, `turnId`, `author`, `source` e `evidence`, conforme [Interações](INTERACTIONS.md#aplicação-explícita-de-uma-release-da-api-manual):

```powershell
node dist/src/cli.js learning-application --file application.local.json
node dist/src/cli.js learning-effects CANDIDATE_ID
```

MCP: `record_learning_application({input})` e `read_learning_effects({candidateId})`. A release precisa ter estado ativa no início do turno, com hash correspondente e telemetria existente. O recibo declara aplicação; não certifica execução correta. A comparação usa baseline anterior à primeira promoção e turnos posteriores completos com aplicação explícita, mantendo projeto/escopo e N de cada contador. A ausência de baseline, escopo ou término retorna `pending`; uma diferença de tokens não comprova por si só melhoria de qualidade ou economia de assinatura.

## Como interpretar o painel

| Situação | Leitura correta |
|---|---|
| Job `kind: checks`, sem worker de modelo | Modelo/esforço/tokens do worker são `not applicable`. O consumo da conversa coordenadora não é medido por esses checks. |
| Job `kind: codex`, receipt ou métrica ausente | Informação desconhecida; não assumir zero consumo, cleanup concluído ou sucesso. |
| Learning Queue mostra sinal de uma tentativa | É evidência para investigar. Candidato reutilizável exige achado explícito com conteúdo e referências. |
| Não existem comparações compatíveis | Não há evidência suficiente para comparar; não é uma medida de ganho zero. |
| Conteúdo promovido aparece no contexto posterior | O caminho/hash comprova inclusão. Uso correto e efeito sobre o resultado exigem evidência adicional. |
| Série de tokens vazia | Confira opt-in, turnos completos e projeto/escopo declarados antes do turno. Contador ausente não é zero. |
| Manifesto aparece inválido após atualização | Confira também a versão/fingerprint do processo observe; ele pode ainda estar carregando um reader antigo. |

## Atualizar o observador

O painel compara a versão e o fingerprint dos arquivos JavaScript de `dist/src` capturados ao iniciar o serviço com os instalados no disco. `restartRequired:true` identifica mudança mesmo sem alteração de versão do pacote. `null` indica que a evidência necessária não pôde ser lida. Refresh repete a consulta ao mesmo processo; não carrega módulos novos no backend.

Depois do build e da validação local, se o painel indicar reinício necessário, encerre **somente o processo observe desta instalação** e inicie-o novamente:

```powershell
node dist/src/cli.js observe --port 4317 --timeout 7200000
```

Se estiver no terminal que iniciou esse processo, `Ctrl+C` o encerra. Para processo oculto, confira o PID/comando proprietário antes de pará-lo; não encerre todos os processos Node. Atualize o navegador e confira se o alerta desapareceu. Isso não exige reiniciar jobs, produtos, Docker ou o computador. O observador não se reinicia sozinho. Manifests e receipts históricos são preservados; não os recrie para ocultar um warning.

## Segurança e recuperação

`security_report` consome relatórios existentes, com enriquecimento opcional `feeds.mode: enrich`. Feeds indisponíveis preservam informação desconhecida. A publicação GitHub usa dry-run por padrão; envio real exige configuração, credencial de ambiente e autorização exata/fresca. Essa ferramenta não faz scan, patch ou deploy.

`snapshot` e `restore` usam destinos novos. Faça restauração em outra pasta, valide o manifesto, reconcilie owners e ative apenas os perfis escolhidos após revisar caminhos. A cópia inclui estado e artefatos privados: **não a use como pacote de distribuição**. Node/npm, dependências, autenticação e vínculos de plugin são reconstruídos na máquina de destino.

## Validação local

`npm run verify` executa build, a suíte completa do núcleo e typecheck/build da UI, preservando um recibo na área local de artefatos. Não gera uma tarefa de modelo e não publica no GitHub. Após alterações posteriores no candidato, revalide antes de um push.
