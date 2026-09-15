# Diagnóstico de recusas de aprovação

Há três origens distintas que exigem diagnóstico próprio:

| Sinal | Origem | Tratamento |
|---|---|---|
| EPERM ao limpar uma fixture própria | Filesystem e ACL | Conferir proprietário, caminho e processos; corrigir somente a permissão da fixture autorizada. |
| `blocked by policy` antes da execução | Camada de aprovação da ferramenta | Preservar a recusa e a justificativa disponível. Uma configuração local permissiva não prova a causa. |
| `client/serverRequestRejected`, `source: infra-client` | Cliente não interativo do CodexInfra | Correlacionar `threadId`, `turnId`, `itemId` e `commandSha256`; o cliente não possui canal interativo de aprovação. |

O cliente continua recusando solicitações de aprovação do servidor. A versão 0.8.0 melhora a identificação da origem e a correlação da operação; não altera a decisão nem políticas externas. Recibos omitem comando, argumentos, material de credencial e justificativa bruta potencialmente sensível.

Uma recusa não autoriza repetir a mesma ação por outro executor nem desativar controles. Inspecione a justificativa disponível e use o mecanismo de aprovação da interface quando suportado. O diagnóstico não equivale a uma limpeza concluída ou a uma política corrigida.

Validação: `test/app-server.test.ts` e `test/codex-worker.test.ts` verificam a rejeição preservada e os metadados sem comando sensível. Execute a suíte local da distribuição antes de publicar.
