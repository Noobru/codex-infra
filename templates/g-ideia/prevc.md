# {{projectName}} — PREVC Mestre

> Acompanhamento de Planning, Review, Execution, Validation e Confirmation.
> Estado inicial: planejamento em preparação; nenhum gate aprovado pelo bootstrap.

## Fontes

[Control Plane](<{{indexFile}}>), [PRD](<{{prdFile}}>), [SPEC](<{{specFile}}>),
[Evidências](<{{evidenceFile}}>).

## Fases

| Fase | Status | Responsável | Entradas | Entregáveis | Evidência | Gate de saída | Bloqueios | Próxima ação |
|---|---|---|---|---|---|---|---|---|
| P — Planning | Em preparação | A definir | Pedido e fontes | Problema, PRD e plano | Pendente | Escopo e aceite definidos | Fontes/decisões a confirmar | Reconstruir contexto |
| R — Review | Não iniciado | A definir | PRD e proposta | Revisão e SPEC/ADRs | Pendente | Solução e riscos pertinentes revisados | Depende de P | Revisar plano |
| E — Execution | Não iniciado | A definir | Plano autorizado | Implementação rastreável | Pendente | Escopo implementado | Depende de P/R | Definir primeira fatia |
| V — Validation | Não iniciado | A definir | Implementação e aceite | Checks e evidências aplicáveis | Pendente | Critérios comprovados | Depende de E | Executar validação adequada |
| C — Confirmation | Não iniciado | A definir | Evidências e estado vivo | Documentos, write-back e entrega | Pendente | Fontes reconciliadas e entrega confirmada | Depende de V | Conferir e entregar |

## Primeira fatia verificável

Registrar requisito, entrada, resultado observável, dependências mínimas, aceite e
forma de validação. Quando não houver benefício, explicar brevemente sem criar gate extra.

## Trabalho e rastreabilidade

| Task | Status | Priority | PREVC | Domain | Release | Requirement IDs | Owner | Evidence | Source |
|---|---|---|---|---|---|---|---|---|---|
| A definir | Rascunho | A definir | P | Engenharia | A definir | A definir | A definir | Pendente | Pedido a consolidar |

Usar IDs estáveis e ligar PRD, decisões, arquivos/SHAs, issues/PRs, checks e evidências.
Se Notion for obrigatório, manter database tipado canônico e readback; esta tabela
local não afirma sua existência. Concluir uma fatia não conclui o PREVC global.
