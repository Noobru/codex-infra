# Delegação até a entrega

O coordenador transforma o pedido em um contrato verificável, executa as ações autorizadas, recupera falhas previstas e apresenta o resultado junto das decisões que ainda exigem uma pessoa. O vault continua sendo fonte de contexto.

## Preparação pelo coordenador

Leia a intenção no contexto da conversa. Uma pergunta sobre uma ferramenta ou um projeto usado como exemplo não escolhe tecnologia, muda objetivo ou autoriza execução. Registre `steering` em `record_interaction` quando houver uma correção material; perguntas/exemplos não podem mudar objetivo, projeto ou encerrar a interação. Pausa expressa requer também `cancel`/`stop_queue`/`workflow-cancel` no trabalho afetado: registrar intenção não interrompe processos sozinho.

PRD/PREVC produzidos a pedido e aprovados continuam sendo o contrato. Referencie essa aprovação em `taskDetails.intent.approvedPlanRefs`; não peça aprovação repetida de escolhas técnicas já cobertas. O campo registra a fonte da autorização, sem ampliar seu conteúdo.

Para novos trabalhos com múltiplas etapas, preencha os campos pertinentes:

```json
{
  "taskDetails": {
    "intent": {
      "kind": "continuation",
      "source": "Pedido atual para executar o plano aprovado",
      "approvedPlanRefs": ["PRD/requisito aprovado"],
      "interpretation": "Concluir o relatório autorizado e verificar suas fontes"
    },
    "outcomeCriteria": [
      {"id":"report","description":"Relatório contém a conclusão acordada","kind":"artifact","path":"output/report.md","contains":"## Conclusão"},
      {"id":"sources","description":"Referências e conteúdo passam no verificador do projeto","kind":"check","checkId":"verify-report"}
    ],
    "resolution": {
      "maxAttempts": 3,
      "source": "Autorização vigente para corrigir e validar a entrega local",
      "actions": [{"id":"repair-report","instruction":"Corrigir o relatório dentro do escopo aprovado e executar novamente a validação; preservar as fontes.","triggers":["worker-blocked","check-failed","outcome-failed"]}]
    }
  }
}
```

O check citado precisa existir no perfil e estar selecionado em `checkIds`. Critérios de artefato aceitam `contains`, `sha256` ou ambos, com caminho relativo dentro do workspace e arquivo regular até 1 MiB. Um relatório pode usar `checkIds:[]` se houver critérios explícitos de artefato. Presença de texto/hash comprova somente essa propriedade: não comprova a qualidade de uma pesquisa. Use validação de conteúdo e julgamento independente quando necessários ao aceite.

## Recuperação e continuidade

### Prazo, cancelamento e delegação longa

Para pesquisa/review ou trabalho longo, use `delegate_task` com `background:true`
e `timeoutMs` explícito, até `1800000` (30 minutos). O supervisor canônico recebe
somente aquele job e devolve seu recibo imediatamente. Consulte `task_status`,
`queue_status` e `delivery_status`; recibo/PID não é conclusão. Repetir a mesma
delegação não abre outro supervisor. Após retry explícito do job, use
`start_queue` com `jobIds:[jobId]` para executar a nova tentativa.

O modo foreground de `delegate_task` e `run_task` via MCP é limitado a `240000`
ms para reservar tempo ao encerramento antes do timeout do transporte MCP.
A CLI `run --timeout` usa o mesmo núcleo e permite até `1800000` ms, pois seu
processo pode ser acompanhado fora da espera MCP; para despacho desacoplado,
prefira `delegate` com `background:true` ou `start-queue`.
Timeout de execução registra `failed`, preserva a causa em `attempt-N/stop.json`
e libera o lock somente após cleanup confirmado. Permite retry explícito com
histórico da tentativa anterior. Cancelamento solicitado registra `cancelled`,
terminal: para voltar ao objetivo, revise a evidência e prepare um novo job com
nova chave. Cancelamentos históricos não são reclassificados automaticamente.
Uma interrupção de runtime sem causa local confirmada permanece `failed`, sem
atribuir cancelamento ao owner nem repetir o trabalho automaticamente.

`acceptanceCriteria` descreve o aceite humano; não substitui `outcomeCriteria`
verificável nem `checkIds` cadastrados. Não escolha `git-status` ou outro check
sem relação com o resultado apenas para satisfazer o gate. A seleção de workspace
vem do perfil: se ele permite apenas worktree, forneça uma base local explícita.
Rota coordenador não é falha de execução: mantenha o trabalho acoplado na conversa.

O worker devolve `blocker` com tipo, razão, evidências, próxima ação e `recoveryActionId` (ou `null`). Tipos: `recoverable`, `missing-information`, `external-dependency`, `owner-decision`, `platform`, `global`.

Só `recoverable` com uma ação previamente registrada pode gerar tentativa automática. O coordenador usa o mesmo executor, perfil, recursos e contrato. O limite é de 1 a 4 tentativas totais; retomada não reinicia esse orçamento. O prazo total, cancelamento, cleanup e repetição sem evidência nova também encerram recuperação. Cada tentativa conserva seus recibos. Efeitos externos continuam sujeitos às autorizações do projeto.

Em DAGs, use `continueIndependent:true` para concluir nós independentes diante de um bloqueio local conhecido. Os dependentes do nó bloqueado aguardam. Cota, cancelamento, falha global ou processo sem encerramento confirmado continuam impedindo despachos afetados. Em fila avulsa, essa opção exige `jobIds` explícitos; CLI: `drain`/`start-queue --jobs ... --continue-independent`.

Uma decisão humana deve conter o material já preparado, a recomendação e a ação mínima necessária. Uma dependência de assinatura não impede produzir o pacote para assinar nem concluir trabalho independente. Não invente assinatura ou aceite de outra pessoa.

## Fechamento e avaliação

`delivery_status({jobId})` ou `delivery JOB_ID` devolve critérios, hashes, bloqueio, decisões e próxima ação. `technicalCompleted`, `outcomeStatus` e `humanAcceptance` são distintos. Jobs antigos continuam legíveis e aparecem com resultado `not-recorded` quando não contrataram critérios verificáveis.

No workflow, `acceptance:[{id,description,nodeId,criterionId}]` liga o objetivo aos critérios dos nós. Todos os itens mapeados precisam passar contra o hash do contrato vigente. O coordenador deve cobrir todos os requisitos materiais: o sistema não consegue descobrir automaticamente um requisito omitido.

Avaliações automáticas incluem os critérios de resultado. Checks verdes não apagam um resultado ausente ou reprovado. Comparações incluem a assinatura dos critérios; aceite humano só é registrado quando observado.

## Limites e adoção

Os campos são opcionais para compatibilidade; o coordenador deve usá-los em novos trabalhos pertinentes. Não há interceptador universal de conversas nem migração automática de jobs existentes. Novas ferramentas/skill exigem uma nova tarefa ou recarga do plugin; uma CLI recompilada usa o núcleo atual imediatamente.

A implementação limita e torna rastreáveis ações e verificações. O alinhamento semântico depende da interpretação do agente e deve ser avaliado com exemplos reais, correções e aceite do usuário. Meça intervenções necessárias, retrabalho após revisão e entregas corretas, além de tempo e tokens; testes técnicos não provam ganho de produtividade ou confiança generalizada.
