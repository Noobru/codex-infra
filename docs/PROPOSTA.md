# Proposta e hipóteses de benefício

CodexInfra organiza o trabalho de um agente local em torno de objetivos explícitos, contexto versionado, execução observável e conhecimento revisado. A distribuição é voltada ao uso pessoal de desenvolvimento com Codex Desktop.

## Como muda o trabalho

| Momento | Fluxo adotado |
|---|---|
| Início | Conversa/discovery esclarece o objetivo; o agente carrega o vault de coding, seus contratos e o estado do projeto. |
| Formalização | G-IDEIA rege PRD/PREVC e SPEC/ADRs proporcionais. Projeto existente reaproveita seus artefatos canônicos. |
| Planejamento | Requisitos, fontes obrigatórias, resultado esperado, checks, limites e decisões relevantes acompanham a tarefa. |
| Execução simples | O coordenador trabalha diretamente e preserva o resultado pertinente. |
| Execução demorada | Uma tarefa persistente conserva contrato, tentativas, owner e evidências. |
| Trabalho com dependências | Um workflow divide nós úteis, repassa resultados e consolida o plano. |
| Falha | O agente lê a evidência e decide uma retomada ou revisão limitada; não repete efeitos cegamente. |
| Conclusão | Resultado, checks e estado real ficam rastreáveis; confirmação PREVC e write-back seguem o contrato do vault. |
| Aprendizado | Achados e retrabalho observado viram bundle executável; revisão independente e testes precedem ativação automática pela política permanente do owner. O painel informa o hash para uso e desativação. |
| Próxima conversa | O agente recupera as fontes e os registros pertinentes ao objetivo atual. |

O usuário não precisa pedir cada mecanismo individualmente. Depois da adoção no contrato global, o coordenador escolhe os mecanismos proporcionais à tarefa. Múltiplos workers e DAGs continuam escolhas de execução, não etapas obrigatórias para toda pergunta. O registro de interação guarda continuidade; a fonte básica de verdade de engenharia é o vault de coding com seus contratos, e o escopo do projeto permanece ligado ao PRD/PREVC vigente.

## O que esperamos melhorar

| Hipótese | Mecanismo que pode ajudar | O que observar no uso |
|---|---|---|
| Menos reconstrução de contexto | Perfis, checkpoints, fontes com hash e recuperação seletiva. | Quantas informações precisam ser explicadas novamente ao retomar. |
| Menos retrabalho | Critérios de aceite, checks e evidências preservadas. | Correções repetidas e regressões ao longo de tarefas comparáveis. |
| Melhor uso da cota | Roteamento explícito, trabalho direto quando suficiente e delegação delimitada. | Consumo observado junto da qualidade entregue, sem equivaler tokens a percentual da assinatura. |
| Menos supervisão manual | Estado persistente, limites, cancelamento e retomada revisada. | Intervenções necessárias para terminar uma tarefa autorizada. |
| Reuso de soluções úteis | Capacidades revisadas, testadas e chamadas pelo hash em tarefas seguintes. | Execuções reais, resultados, duração e versões desativadas quando inadequadas. |

Esses benefícios ainda não foram demonstrados como resultado causal. A infraestrutura registra funcionalidade e evidências; o usuário avalia utilidade e custo no uso contínuo. Não foi estabelecida equivalência com ambientes internos de pesquisa ou engenharia de terceiros.

## Custos e escolhas práticas

Cadastro e manutenção das fontes consomem atenção. A execução por modelos utiliza o acesso e os limites da conta de cada usuário. Paralelismo pode terminar partes independentes mais cedo e também pode aumentar consumo e coordenação. Um contexto excessivo ou uma prática ruim promovida pode atrapalhar; por isso seleção, revisão e reversão fazem parte do fluxo.

O núcleo usa um grafo explícito sobre fontes autorizadas, sem embeddings, banco vetorial ou daemon permanente. O agente continua nativo no Windows. A execução das capacidades geradas usa Docker já ativo, imagens locais e rede desabilitada; não inicia serviços nem baixa dependências automaticamente. A autorização do owner é configurada uma vez na instalação e o aprendizado compartilha os limites dos workers. [Contrato do ciclo](AUTONOMOUS-LEARNING.md).
