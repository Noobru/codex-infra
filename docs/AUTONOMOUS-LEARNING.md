# Aprendizado executável por política

Na versão 0.6.0, achados de interações e padrões observados de retrabalho podem virar capacidades executáveis. O agente constrói, revisa, testa e ativa a melhoria sob uma autorização permanente do owner. O painel mostra a versão e seu hash; o owner pode informar esse hash para desativá-la, sem aprovar cada promoção.

O ciclo foi validado em uma aplicação pequena própria: duas falhas equivalentes originaram uma skill, a revisão rejeitou a primeira versão, o reparo foi escalado automaticamente, e a versão aprovada passou pelos testes isolados, foi ativada e corrigiu a entrada do consumidor por uma chamada MCP. A suíte local verifica também os gates, retomadas, contexto, desativação e recuperação. Para validar sua instalação, execute o procedimento de CI local descrito no README.

## O ciclo real

### Casos que precisam de atenção

`attention` significa que o ciclo estacionou; não promete que há agente trabalhando. Após diagnosticar a causa, `learning-recover ID --file decision.json` (MCP `recover_learning_case`) registra uma decisão com `expectedRevision`, `author`, `source`, `evidence` e `action`:

- `resume`: usado para uma construção interrompida com input imutável. Primeiro inspecione o worker e seus arquivos, faça `retry JOB_ID` explicitamente e execute-o com o limite adequado. A recuperação exige que esse mesmo worker tenha concluído seus checks; então recoloca o caso na fila para revisão independente, testes isolados e ativação. `learning-reconcile` despacha o ciclo. Um bundle rejeitado não é reaprovado por esse mecanismo.
- `supersede`: exige `successorId` de um caso com versão já validada e ativada, mesmo que depois desativada. Registre por que esse sucessor cobre o caso antigo. O antigo passa ao Histórico como substituído; não ganha uma ativação ou sucesso fictício, nem reativa o sucessor.

As duas ações preservam falhas, contadores, IDs e revisões anteriores. Não alteram a política nem repetem workers implicitamente. Revisão desatualizada, fase em andamento e evidência de sucessor insuficiente são recusadas.

1. A conclusão de checks e os resultados materiais registrados na interação alimentam a descoberta. Repetições são agrupadas por evidência compatível; um erro isolado não prova uma solução reutilizável. `findings` explícitos preservam conteúdo, projeto e revisão de origem.
2. Um caso persistente recebe síntese e revisão em dois jobs do `TaskEngine`. Cada etapa usa seu próprio workbench dentro dos artefatos da infraestrutura, sem executar o produto que originou o sinal.
3. A síntese gera `bundle.json`: versão, arquivos, entrypoints Node/Python e testes. Os checks desta etapa validam somente o schema do JSON. O código gerado permanece como dado.
4. Outro job revisa uma cópia exata do bundle e registra decisão, motivo, evidências e hash. Mudança no conteúdo durante a revisão invalida o resultado.
5. O runtime publica o bundle imutável, vincula a revisão e executa seus testes em cópias isoladas. Cada teste registra comando, saída, exit code, integridade dos arquivos e a prova do isolamento usada.
6. Com revisão aprovada e testes confirmados, o agente ativa a versão. A decisão registra `author.role: model`, o hash da política e a autorização permanente do owner separadamente. Uma falha preserva o diagnóstico e pode originar uma nova tentativa dentro do limite configurado.
7. Contextos futuros recebem a referência da capacidade ativa e, em skills, o `SKILL.md`. A chamada pelo hash produz outputs e um recibo real de execução. O hash desativado deixa de entrar nos próximos contextos e não pode ser chamado novamente.

O bundle é uma capacidade local da infraestrutura; não é instalado como skill global. Publicar arquivos, aplicar outputs num produto, fazer push ou deploy continuam ações da tarefa autorizada correspondente.

## Ativar a política na própria instalação

Cada destinatário configura sua própria autorização uma vez. A instalação não copia a decisão do autor do projeto. Consulte a configuração e, quando o owner autorizar o ciclo, prepare `learning-policy.local.json` com sua identidade, referência da decisão e projetos permitidos:

```json
{
  "version": 1,
  "enabled": true,
  "automaticActivation": true,
  "authorizedBy": { "name": "Nome do owner", "role": "owner" },
  "source": "Referência à autorização permanente desta instalação",
  "evidence": ["Referência real da decisão do owner"],
  "allowedProjectIds": ["projeto-exemplo"],
  "maxBuildAttempts": 2,
  "maxCasesPerDrain": 1,
  "workerTimeoutMs": 300000,
  "maxTimeoutMs": 30000,
  "allowedKinds": ["script", "skill", "practice"],
  "allowedRuntimes": ["node", "python"]
}
```

Substitua os valores ilustrativos pelos dados da decisão real. `allowedProjectIds: ["*"]` inclui todos os projetos no escopo da autorização. Identidade declarada não é autenticação nem permite ao agente se apresentar como owner.

```powershell
node dist/src/cli.js learning-policy
node dist/src/cli.js learning-policy --file learning-policy.local.json
node dist/src/cli.js learning-cycle
node dist/src/cli.js capabilities --project projeto-exemplo
```

A configuração persistida fica em `profiles/learning-policy.json`, local e fora da distribuição. Sem política habilitada, o ciclo não ativa capacidades. `enabled: false` também impede invocações e retira essas capacidades da seleção futura de contexto. `automaticActivation: false` suspende novas ativações automáticas; os hashes já ativos mantêm a autorização de uso enquanto a política geral continuar habilitada.

## Limites e retomada

Casos substituídos por uma sucessora validada encerram seus jobs pendentes sem
owner ativo. Reaplicar a mesma substituição com a revisão atual reconcilia casos
históricos sem criar outra revisão; falhas terminais e execuções vivas são
preservadas. Isso não retoma ou cancela trabalho alheio ao caso.

Depois de integrar bundle e revisão em `result.json`, o construtor finaliza o uso
dos dois workers por `DelegationLifecycle`. Delegações comuns usam
`finish_delegation` / `finish-delegation JOB_ID --file DECISION.json`: a decisão
identifica a tentativa, a thread real, `integrated:true`, autor, fonte e evidências.
O app-server oficial confirma o arquivamento recuperável. O recibo `archived`
torna repetição idempotente; falha gera `pending`, preservado para investigação
e nova finalização. Conclusão do job não equivale a integração do seu resultado.

## Medir uso e resultado

`run_learning_capability` aceita `threadId` explícito para resolver o turno aberto
pela telemetria opt-in, ou `attribution:{threadId,turnId}` quando os IDs reais já
forem conhecidos. Contexto incluído, chamada executada e aplicação dos outputs
são evidências diferentes. Ausência de atribuição histórica não é corrigida por
inferência.

O leitor de efeitos usa a ativação automática do hash, sem exigir promoção manual.
Compara turnos completos do mesmo projeto, escopo declarado, modelo e esforço
observados; diferentes hashes têm grupos próprios. O baseline termina antes da
ativação e a chamada precisa pertencer ao intervalo do turno. Várias chamadas
no mesmo turno contam uma vez nas médias, incluindo chamadas que falharam.
Cada métrica informa seu denominador e mantém ausências como desconhecidas.
O período selecionado limita as amostras. Recibos antigos sem modelo/esforço
continuam válidos como contadores, mas não entram numa comparação compatível.
Modelo é o identificador observado no contexto do turno, não prova de uma versão
interna imutável do provedor. Diferenças são associações descritivas, não economia
causal, monetária ou de cota.

## Orçamento do ciclo

A síntese inicial é uma tarefa delimitada, com verificação independente e risco baixo: a política de roteamento existente seleciona Luna. Uma tentativa de reparo após falha relevante volta ao coordenador forte, Astra. A revisão separável usa Sol. O catálogo real confirma a disponibilidade antes de gerar; o roteiro não cria uma cadeia obrigatória de modelos para outras tarefas.

Os jobs compartilham os limites de `execution-policy`, os claims e a exclusividade de recursos do motor. O padrão da política de aprendizado é um caso por ciclo, até duas tentativas e cinco minutos por worker. Cada teste ou invocação tem seu limite próprio, inicialmente 30 segundos. Perfis internos usam o prefixo `learning-` para não gerar recursivamente novos casos a partir da manutenção.

O supervisor é temporário e limitado. Entrada persistente de trabalho e novos resultados podem iniciar essa manutenção quando a política já a autoriza. `productDispatch` continua falso na entrada: consultar ou mencionar um projeto não despacha seus jobs. `persist:false`, consultas do painel e leituras de status não iniciam manutenção.

Quota e admissão ocupada preservam o job e voltam a ser considerados na próxima atividade após o cooldown do coordenador. Retomada de quota usa o mesmo job e sua evidência; decisões pendentes, cancelamento e cleanup não confirmado mantêm seus gates. Não há loop ilimitado nem promessa de um daemon permanente.

## Isolamento da execução

O Codex e a infraestrutura continuam nativos no Windows; WSL não é exigido pelo runtime do agente. Para executar capacidades geradas, o adaptador atual usa um Docker **já ativo**, com imagens locais disponíveis. Ele não inicia Docker/WSL, não baixa imagens e não instala pacotes.

Os defaults estão em `src/learning-sandbox.ts`: `node:22.23.2-bookworm-slim` e `python:3.13.15-slim-bookworm`. Antes da chamada, o adaptador resolve o ID exato da imagem local e usa `--pull=never`. O container tem rede desabilitada, filesystem raiz somente leitura, usuário sem privilégios e um único workspace próprio montado para escrita. Não recebe diretórios do produto nem credenciais do host.

A prova de isolamento usa uma fixture própria para confirmar escrita dentro do workspace, recusa de escrita fora dele e ausência de conectividade. Limites de duração e cleanup pertencem à execução. Um CWD separado, um VM de JavaScript ou um campo de configuração alegando bloqueio de rede não substituem essa prova. Se o ambiente necessário estiver indisponível, o caso fica visível para atenção antes de consumir uma nova síntese.

## Chamar uma capacidade e desativar pelo hash

Use `run_learning_capability({hash,input})` com `projectId` exato, `entrypoint`, argumentos, arquivos de entrada e outputs desejados. As entradas são copiadas para um workspace novo; não podem substituir arquivos do bundle. O retorno preserva conteúdo/hash dos outputs e o resultado do comando.

Exemplo de `invocation.local.json`, adaptado ao contrato da capacidade escolhida:

```json
{
  "projectId": "projeto-exemplo",
  "entrypoint": "normalize",
  "args": ["input.txt", "output.txt"],
  "inputFiles": [{ "path": "input.txt", "content": "texto fornecido" }],
  "outputPaths": ["output.txt"],
  "decision": {
    "author": { "name": "Agente da tarefa", "role": "model" },
    "source": "Objetivo autorizado da tarefa atual",
    "evidence": ["Referência real do objetivo"]
  }
}
```

Quando conhecidos, acrescente `attribution: {threadId, turnId}` com UUIDs reais da tarefa e do turno. Omitir atribuição não impede a execução; IDs inventados não são aceitos como evidência de uso comparável.

```powershell
node dist/src/cli.js capability-run HASH_COMPLETO --file invocation.local.json
node dist/src/cli.js capability-disable HASH_COMPLETO --file owner-decision.local.json
```

`owner-decision.local.json` contém `{author:{name,role:"owner"},source,evidence}` com a solicitação real do owner. Pelo MCP, use `disable_learning_capability({hash,decision})`. A desativação é persistente e exata: o tombstone vence novas ativações do mesmo hash, preservando manifesto, revisões, testes e runs. Ela bloqueia o uso futuro; não reverte outputs já aplicados nem declara um processo em andamento encerrado.

## Evidência e acompanhamento

Referências de evidência enviadas à construção, revisão e ativação respeitam o limite de 50 por contrato. O primeiro item aponta ao recibo imutável que conserva a origem completa; a história do caso não é truncada. Exceções anteriores ao build ficam em `attention`, com a causa registrada e sem repetição automática cega. Falhas de supervisor aparecem no painel; um erro de entrada resolvido por reconciliação bem-sucedida mantém o recibo com `resolvedAt`.

`workerTimeoutMs` limita a primeira construção e a revisão. O reparo usa o dobro desse prazo, limitado a 600.000 ms; `repairWorkerTimeoutMs`, opcional em processos atualizados, permite um limite explícito dentro do mesmo teto. O supervisor usa o orçamento compartilhado. O número máximo de tentativas não aumenta e um caso já esgotado não é reaberto automaticamente. Mantenha o campo opcional ausente enquanto MCPs antigos ainda estiverem carregados; o cálculo padrão já oferece o prazo de reparo sem invalidar a política nesses processos.

| Artefato | O que comprova |
|---|---|
| `artifacts/learning/cases/` | Caso, origem, tentativas, jobs, estado e próximo impedimento. |
| `artifacts/learning/builds/` | Inputs, bundle gerado e revisão independente ligados aos jobs. |
| `artifacts/learning/runtime/bundles/<hash>/` | Manifesto, arquivos, estado, decisão de ativação e desativação. |
| `artifacts/learning/runtime/validations/` | Testes realmente executados contra aquela versão. |
| `artifacts/learning/runtime/runs/` | Invocações reais, resultados, outputs e atribuição quando fornecida. |

Efficiency separa contexto disponível, aplicação declarada do fluxo antigo e execução real de uma capacidade. Contagens, duração, timestamps e hash vêm dos recibos. Uma execução isolada não é convertida em economia de tokens; comparações de tokens requerem contadores completos e escopo compatível. O benefício esperado permanece uma hipótese avaliada no uso.

As APIs manuais anteriores de `propose_learning`, `review_learning`, shadow, `promote_learning` e `revert_learning` continuam disponíveis. A promoção manual conserva sua decisão explícita do owner. O ciclo automático usa a política permanente e seus próprios bundles executáveis, reviews e testes; não reutiliza um `.txt` inerte como prova de execução.

Fontes canônicas: `src/autonomous-learning.ts`, `src/rework-discovery.ts`, `src/learning-builder.ts`, `src/learning-runtime.ts`, `src/learning-sandbox.ts` e seus schemas. Entrada e proveniência: [Interações](INTERACTIONS.md).
