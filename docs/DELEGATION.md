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
