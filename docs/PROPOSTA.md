# Proposta e hipóteses de benefício

CodexInfra organiza o trabalho de um agente local em torno de objetivos explícitos, contexto versionado, execução observável e conhecimento revisado. A distribuição é voltada ao uso pessoal de desenvolvimento com Codex Desktop.

## Como muda o trabalho

| Momento | Fluxo adotado |
|---|---|
| Início | O usuário define o objetivo. O agente resolve o projeto e consulta fontes e estado antes de agir. |
| Planejamento | Resultado esperado, checks, limites e decisões relevantes acompanham a tarefa. |
| Execução simples | O coordenador trabalha diretamente e preserva o resultado pertinente. |
| Execução demorada | Uma tarefa persistente conserva contrato, tentativas, owner e evidências. |
| Trabalho com dependências | Um workflow divide nós úteis, repassa resultados e consolida o plano. |
| Falha | O agente lê a evidência e decide uma retomada ou revisão limitada; não repete efeitos cegamente. |
| Conclusão | Resultado, checks e estado real ficam rastreáveis. |
| Aprendizado | Conteúdo reutilizável vira candidato; revisão e validação precedem promoção explicitamente autorizada. |
| Próxima conversa | O agente recupera as fontes e os registros pertinentes ao objetivo atual. |

O usuário não precisa pedir cada mecanismo individualmente. Depois da adoção no contrato global, o coordenador escolhe os mecanismos proporcionais à tarefa. Múltiplos workers e DAGs continuam escolhas de execução, não etapas obrigatórias para toda pergunta.

## O que esperamos melhorar

| Hipótese | Mecanismo que pode ajudar | O que observar no uso |
|---|---|---|
| Menos reconstrução de contexto | Perfis, checkpoints, fontes com hash e recuperação seletiva. | Quantas informações precisam ser explicadas novamente ao retomar. |
| Menos retrabalho | Critérios de aceite, checks e evidências preservadas. | Correções repetidas e regressões ao longo de tarefas comparáveis. |
| Melhor uso da cota | Roteamento explícito, trabalho direto quando suficiente e delegação delimitada. | Consumo observado junto da qualidade entregue, sem equivaler tokens a percentual da assinatura. |
| Menos supervisão manual | Estado persistente, limites, cancelamento e retomada revisada. | Intervenções necessárias para terminar uma tarefa autorizada. |
| Reuso de soluções úteis | Candidatos revisados, validados e promovidos para contextos seguintes. | Práticas reaplicadas com sucesso e práticas revertidas quando inadequadas. |

Esses benefícios ainda não foram demonstrados como resultado causal. A infraestrutura registra funcionalidade e evidências; o usuário avalia utilidade e custo no uso contínuo. Não foi estabelecida equivalência com ambientes internos de pesquisa ou engenharia de terceiros.

## Custos e escolhas práticas

Cadastro e manutenção das fontes consomem atenção. A execução por modelos utiliza o acesso e os limites da conta de cada usuário. Paralelismo pode terminar partes independentes mais cedo e também pode aumentar consumo e coordenação. Um contexto excessivo ou uma prática ruim promovida pode atrapalhar; por isso seleção, revisão e reversão fazem parte do fluxo.

Esta distribuição não exige embeddings, um banco vetorial, Docker, um serviço pago adicional ou um daemon permanente. O contexto avançado disponível é um grafo explícito sobre fontes autorizadas. Feeds externos e publicação de resultados são opcionais.
