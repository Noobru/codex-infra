# Interações e continuidade

Uma interação registra a identidade da tarefa local, intenção, objetivo e estado de continuidade. Ela pode apontar para jobs e workflows reais e também representar trabalho executado diretamente na conversa. Não é um job fictício e não consome uma geração de modelo para existir.

O registro não define sozinho o escopo autorizado. Engenharia segue o vault de coding e seu G-IDEIA: carregar contratos, localizar ou formalizar proporcionalmente PRD/PREVC, executar dentro do requisito, validar e fazer write-back. Projeto existente reaproveita os artefatos canônicos. Consulte [Contrato de contexto](CONTEXT-CONTRACT.md).

## Entrada e atualização

A skill usa `enter_interaction` com a identidade da conversa (`CODEX_THREAD_ID`, quando disponível), título real, fonte do pedido e projeto explicitamente escolhido. A resposta agrega registro anterior, política e contexto pertinente. `persist:false` atende pedidos explícitos de nenhuma gravação. Projetos inferidos de títulos, exemplos ou CWD não são ativados automaticamente.

`record_interaction` atualiza o registro com `expectedRevision`, fonte, resumo breve, status e evidências. IDs de jobs/workflows só entram quando esses objetos existem. Registrar conclusão de trabalho direto é um estado reportado pela conversa; os checks dos jobs preservam sua evidência separada.

## Migração de tarefas existentes

A CLI `node dist/src/cli.js interactions-import --file inventory.local.json` recebe metadados locais selecionados, como ID, título, CWD, estado observado e referência da tarefa. A importação não lê transcrições, não executa o projeto e não interpreta `idle` como concluído. O estado inicial é `imported`; a próxima retomada confirma objetivo e continuidade. Atualizações locais posteriores não são apagadas por um inventário antigo.

Use `InteractionImportSchema` de `src/interactions.ts` para o JSON. Não existe tool MCP de importação em massa; a CLI reutiliza `InteractionStore.importThreads`.

Antes de importar, identifique exatamente quais tarefas Codex locais estão no escopo. Conversas de outros clientes ou contas não são incluídas por associação. Metadados importados podem ser privados e permanecem na área de artefatos ignorada pelo Git.

## Aprendizado a partir de interação

Uma proposta pode usar `origin:{interactionId,revision}` para vincular uma correção ou prática à evidência daquela revisão. O ciclo de revisão, shadow test, promoção explícita e reversão permanece obrigatório. A conversa inteira não deve ser copiada para o candidato.

Os contratos canônicos ficam em `src/interactions.ts` e `src/interaction-entry.ts`. CLI e MCP compartilham essas classes.
