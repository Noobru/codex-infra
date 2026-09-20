# Governança por unidade de trabalho

Uma unidade registra uma decisão antes do trabalho: objetivo, fontes da qualificação, resultado verificável, escolha de executor e recuperação. Reusa InteractionStore/KnowledgeFiles, TaskContract, RoutingPolicy, TaskEngine, fila/supervisor, checks e OutcomeVerifier. Não há outro scheduler nem interceptação de ferramentas do Desktop.

## Caminho operacional

1. Na interação de trabalho ativa e no projeto explícito, chamar `prepare_work_unit` com `interactionId`, revisão atual, `unitId` estável, objetivo, modo, `routing`, `decisionEvidence`, `recoveryReason`, checks e `taskDetails.outcomeCriteria`. Declarar as fontes obrigatórias e o contexto necessário. A qualificação é responsabilidade do coordenador, sustentada por fontes e dependências; referências não certificam automaticamente sua adequação semântica.
2. Para execução separável, informar `executionTarget:worker` e `evidenceRefs`. A política escolhe modelo/esforço. Complexidade/incerteza alta, separável e sem risco alto pode usar o modelo forte configurado como worker; isso não simula um pedido explícito de modelo pelo owner. Falta dos requisitos não mantém silenciosamente uma unidade solicitada como worker no coordenador.
3. Para trabalho inseparável, registrar a qualificação e o motivo de retenção; `executionTarget:coordinator` torna a decisão explícita. Executar na conversa, chamar `record_direct_work` com resumo/evidências, e `run_work_unit` para validação contratada. A execução direta permanece declarada, não interceptada. O modelo da conversa não é alterado nem certificado pela seleção esperada.
4. `run_work_unit` usa background por padrão e retorna job/supervisor. O supervisor aguarda e recupera sem rodadas de modelo para polling. Consultar `work_unit_status` quando houver necessidade de integração ou mudança relevante. Consultas não executam checks ou modelos. Foreground limita 240 segundos; background até 30 minutos por dispatch.
5. `work_summary` reúne decisões, entregas verificadas, jobs vinculados fora das unidades e consumo observado. Contadores cumulativos de uma thread retomada entram uma vez; deltas completos do coordenador entram uma vez por turno. A janela do coordenador é a interação inteira, não cada unidade. Desconhecido/parcial/reset continuam explícitos; não converter em cota, dinheiro ou economia.
6. Depois de integrar o worker, usar `finish_delegation` com tentativa e thread reais. Artefato presente ou completed não substitui leitura do resultado e validação funcional.

CLI equivalente: `work-prepare --file unidade.json`, `work-run --file execucao.json`, `work-direct --file resultado.json`, `work-status --file chave.json`, `work-summary INTERACTION_ID`. APIs e CLI compartilham o mesmo núcleo.

## Recuperação, capacidade e contexto

`taskDetails.resolution` é explícita: fonte de autorização, orçamento, ações, triggers e `causes`. Causas: environment, approval, context, solution, validation, external, unknown. Não contratar recuperação exige razão em `recoveryReason`. Aprovação pendente não é reparada por trocar executor ou repetir operação. A rotina preserva a thread e inclui recibos de progresso, efeitos e bloqueio; não reexecuta tentativa concluída.

Pré-requisitos verificáveis podem ser declarados em `capabilities` como deterministic, stage execution, required true e checkId registrado. Esses checks executam antes do worker. Falha retorna evidência de ambiente e impede gasto de um turno; não instala ferramentas nem concede permissões. Catálogo, login, cota e sandbox continuam verificados no worker.

Na retomada da mesma thread, fontes idênticas são referenciadas por caminho/hash em vez de reenviadas integralmente. Contrato, mudanças, recovery e evidências permanecem no prompt. Fonte/contrato/thread diferentes recebem contexto completo. O limite de excerpts não limita tokens de toda a conversa. Isso reduz texto repetido; não comprova redução de cota.

## Fronteiras de controle e compatibilidade

Unidades têm contratos imutáveis sob a interação. TaskEngine confere vínculo, projeto, objetivo, modo, workspace, checks, qualificação e política antes de preparar/executar. Mudança material pede nova unidade; pausa/fechamento do pai impede novos despachos. Cancelar execução já ativa usa o cancelamento canônico. A preparação não inicia produto implicitamente.

`prepare_task`/`delegate_task`, workflows e registros históricos continuam disponíveis. Um job sem vínculo de unidade não ganha cobertura retroativa; `work_summary` expõe vínculos externos e não estima trabalho Desktop não registrado. A skill orienta adoção do novo caminho; não transforma regra em interceptador universal.

Calibração: confrontar classificação com resultado funcional, bloqueios e esforço de integração em tarefas comparáveis antes de mudar defaults. Manter Astra quando dependências exigirem, delegar quando houver entrega delimitável e usar ferramentas para trabalho determinístico. Nunca buscar porcentagem artificial de delegação. Reparos de aprendizado não sobem de modelo pelo número da tentativa; mudança semântica exige qualificação explícita.
