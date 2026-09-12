# Interações e continuidade

Uma interação registra a identidade da tarefa local, intenção, objetivo e estado de continuidade. Ela pode apontar para jobs e workflows reais e também representar trabalho executado diretamente na conversa. Não é um job fictício e não consome uma geração de modelo para existir.

O registro não define sozinho o escopo autorizado. Engenharia segue o vault de coding e seu G-IDEIA: carregar contratos, localizar ou formalizar proporcionalmente PRD/PREVC, executar dentro do requisito, validar e fazer write-back. Projeto existente reaproveita os artefatos canônicos. Consulte [Contrato de contexto](CONTEXT-CONTRACT.md).

## Entrada e atualização

A skill usa `enter_interaction` com a identidade da conversa (`CODEX_THREAD_ID`, quando disponível), título real, fonte do pedido e projeto explicitamente escolhido. A resposta agrega registro anterior, política e contexto pertinente. `persist:false` atende pedidos explícitos de nenhuma gravação. Projetos inferidos de títulos, exemplos ou CWD não são ativados automaticamente.

`record_interaction` atualiza o registro com `expectedRevision`, fonte, resumo breve, status e evidências. IDs de jobs/workflows só entram quando esses objetos existem. Registrar conclusão de trabalho direto é um estado reportado pela conversa; os checks dos jobs preservam sua evidência separada.

## Declarar o escopo de desempenho

Inclua `performanceScope` na entrada ou atualização quando o trabalho estiver definido. É uma declaração para agrupar evidências semelhantes, não uma classificação extraída do título ou do diretório:

```json
{
  "performanceScope": {
    "taskClass": "syntax-fix",
    "language": "typescript",
    "problemCategory": "syntax"
  }
}
```

Esse é um fragmento: mantenha os outros campos obrigatórios da entrada/update. `taskClass` é obrigatório no objeto; tem até 160 caracteres e aceita letra/número inicial, depois letras, números, ponto, `_` e `-`. `language` é opcional, até 100 caracteres; `problemCategory` é opcional e segue o formato de `taskClass`. Mantenha nomes consistentes para o mesmo tipo de trabalho. Uma falha genérica não comprova erro de sintaxe.

A série de tokens usa projeto/escopo da revisão vigente ao **iniciar o turno**. Escopo registrado depois não é aplicado retroativamente; turnos anteriores sem essa atribuição ficam sem série comparável. Uma retomada preserva campos já registrados; para mudança de objetivo/escopo, atualize a revisão existente. A [telemetria opcional](USO.md#telemetria-local-opcional) guarda somente contadores e metadados de turno, não mensagens ou transcrições.

## Migração de tarefas existentes

A CLI `node dist/src/cli.js interactions-import --file inventory.local.json` recebe metadados locais selecionados, como ID, título, CWD, estado observado e referência da tarefa. A importação não lê transcrições, não executa o projeto e não interpreta `idle` como concluído. O estado inicial é `imported`; a próxima retomada confirma objetivo e continuidade. Atualizações locais posteriores não são apagadas por um inventário antigo.

Use `InteractionImportSchema` de `src/interactions.ts` para o JSON. Não existe tool MCP de importação em massa; a CLI reutiliza `InteractionStore.importThreads`.

Antes de importar, identifique exatamente quais tarefas Codex locais estão no escopo. Conversas de outros clientes ou contas não são incluídas por associação. Metadados importados podem ser privados e permanecem na área de artefatos ignorada pelo Git.

## Aprendizado a partir de interação

Ao identificar uma correção ou prática reutilizável sustentada por evidência, o agente inclui `findings` no update. Cada item exige `id` estável, `projectId` explícito, `title`, `kind` (`practice`, `skill` ou `script`), `content` e `evidence` com ao menos uma referência. Até 50 achados entram por update. O ID tem 1–100 caracteres: letra/número inicial e depois letras, números, ponto, `_` ou `-`. Título/referências têm até 2.000 caracteres e conteúdo até 64.000; o conteúdo é preservado exatamente, recusando material que exigiria sanitização.

Para acompanhar o efeito da melhoria, acrescente `impact`: `problem` e `expectedChange` obrigatórios (até 2.000 caracteres), `language` opcional, `baselineEvaluationIds` (até 20 UUIDs) e `affectedCheckIds` (até 100 IDs de até 160 caracteres). As listas são vazias por padrão. Baselines precisam existir no mesmo projeto; os checks devem constar em suas rubricas. Declare a mudança esperada como hipótese, sem inventar resultados ou IDs para preencher o painel.

Exemplo de `update.local.json`; ajuste revisão, projeto e referências para os valores observados:

```json
{
  "expectedRevision": 2,
  "source": "Diagnóstico observado na tarefa",
  "status": "completed",
  "summary": "Causa observada e correção validada.",
  "findings": [{
    "id": "observer-build-version",
    "projectId": "codex-infra",
    "title": "Conferir o build carregado pelo observador",
    "kind": "practice",
    "content": "Após atualizar o build do observador, compare o fingerprint carregado com o instalado. Se houver diferença, reinicie somente o processo observe e confira a API.",
    "evidence": ["artifacts/integration/example/runtime-comparison.json"],
    "impact": {
      "problem": "Diagnóstico repetido com backend anterior ao build instalado.",
      "language": "typescript",
      "expectedChange": "Reduzir repetições de diagnóstico decorrentes do runtime antigo.",
      "baselineEvaluationIds": [],
      "affectedCheckIds": []
    }
  }]
}
```

```powershell
node dist/src/cli.js record-interaction INTERACTION_ID --file update.local.json
node dist/src/cli.js interaction-findings INTERACTION_ID
node dist/src/cli.js learning-list --project codex-infra
```

No MCP, os equivalentes são `record_interaction({id,input})`, `reconcile_interaction_findings({id})` e `learning_candidates({projectId})`. O retorno de gravação/replay preserva os campos da interação e acrescenta `findingProcessing:{processed,warnings}`. Os itens processados têm `findingId`, `candidateId`, `candidateRevision`, `status` e `artifactPath`.

A interação é salva primeiro. O processamento produz um candidato automaticamente, ligado à primeira revisão do achado (`recordedRevision`) e às evidências dessa revisão. Repetição idêntica e revisões posteriores não duplicam candidatos; mesmo ID com conteúdo incompatível é recusado. Se houver warning de processamento, a revisão já salva continua válida: corrija a causa e execute o replay. Ele não incrementa a revisão nem reinicia review/promoção existentes.

`impact` acompanha essa origem imutável. As listas vazias do exemplo informam que ainda faltam baselines/checks; substitua-as apenas por vínculos reais. Novo conteúdo ou hipótese para achado já gravado exige novo ID. Depois da promoção, o hash e o caminho no Context Pack comprovam inclusão, sem certificar uso correto. Efficiency distingue essa inclusão, o resultado avaliado e a evidência ainda necessária para comparar.

Sem achado explícito, o sistema não inventa uma prática a partir de falha genérica. `Attempt 1` identifica uma tentativa que originou um sinal; não significa um aprendizado nem placeholder. A fila de candidatos pode estar vazia enquanto existirem apenas sinais para investigar. Não há captura automática de toda mensagem: o agente registra os resultados materiais pelo contrato de entrada.

Propostas manuais continuam aceitando `origin:{interactionId,revision}` ou `{jobId,attempt,evaluationId?}`. O ciclo de revisão, shadow test, promoção explícita do owner e reversão permanece obrigatório. Candidato não é executado, instalado ou promovido automaticamente; a conversa inteira não deve ser copiada para ele. Consulte [Instalação e operação](USO.md) para avaliações/comparações automáticas e interpretação dos campos.

## Aplicação explícita de uma melhoria

Se uma release promovida foi aplicada no trabalho, registre a declaração vinculada ao turno real. `LearningApplicationInputSchema` exige `candidateId`, `threadId` e `turnId` UUIDs, `author:{name,role}`, `source` e `evidence` não vazia. O agente se identifica como `model`; não atribui uma opinião sua ao owner.

```powershell
node dist/src/cli.js learning-application --file application.local.json
node dist/src/cli.js learning-effects CANDIDATE_ID
```

Prepare `application.local.json` com esses campos e as identidades/evidências observadas. MCP: `record_learning_application({input})` e `read_learning_effects({candidateId})`. A operação exige recibo de telemetria do turno exato e conteúdo promovido/ativo no início desse turno, conferido por hash. A declaração fica imutável e idempotente em `artifacts/learning/applications/<id>.json`; não executa nem promove conhecimento.

Um turno parcial pode ter aplicação declarada, mas só entra em comparação após medição completa. O antes usa turnos completos anteriores à primeira promoção; o depois usa turnos completos com declaração explícita da release correspondente, no mesmo projeto/escopo. Cada contador tem sua própria amostra. Sem atribuição ou baseline, o resultado é pendente. A associação não certifica execução correta, causalidade, qualidade ou economia de cota.

Os contratos canônicos ficam em `src/interactions.ts` e `src/interaction-entry.ts`. CLI e MCP compartilham essas classes.

Com telemetria opt-in configurada, a entrada persistente e a gravação também retornam `telemetry:{enabled,complete,partial,warnings}` após reconciliar até dez interações locais recentes. `persist:false` não captura. O turno atual pode continuar parcial até seu término ser observado pela próxima entrada/gravação ou replay. Consultar o dashboard não dispara essa coleta. Configuração, comandos e limites: [Instalação e operação](USO.md#telemetria-local-opcional).
