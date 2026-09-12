# Arquitetura e referência

CLI, MCP e workers utilizam o mesmo núcleo TypeScript. SQLite guarda tarefas, dependências e eventos. Arquivos de artefatos preservam contratos, fontes, checks e decisões; a UI lê projeções agregadas desse estado.

O vault de coding do usuário fornece a base canônica de conhecimento e contratos. PRD/PREVC e SPEC/ADRs governam o projeto conforme o G-IDEIA vigente. O registry aponta para essas fontes; contexto e evidências do runtime não as substituem. A ligação é descrita em [Contrato de contexto](CONTEXT-CONTRACT.md).

| Responsabilidade | Implementação canônica |
|---|---|
| Perfis e cadastro | `src/registry.ts`, `src/profile-manager.ts` |
| Bootstrap G-IDEIA | `src/g-ideia-bootstrap.ts`, `scripts/Bootstrap-GIdeia.mjs` |
| Contexto e grafo | `src/context-pack.ts`, `src/knowledge-index.ts` |
| Execução e isolamento | `src/engine.ts`, `src/process.ts`, `src/workspace.ts` |
| Estado e limites | `src/state.ts`, `src/execution-policy.ts` |
| Fila e supervisor | `src/queue.ts`, `src/supervisor.ts` |
| Workflow e repasses | `src/workflow.ts`, `src/execution-evidence.ts` |
| Roteamento de modelos | `src/routing.ts`, `src/model-catalog.ts` |
| Avaliação e aprendizado | `src/evaluation.ts`, `src/knowledge-learning.ts` |
| Segurança e feeds | `src/security-integration.ts`, `src/security-feeds.ts`, `src/security-github-publisher.ts` |
| Recuperação | `src/recovery.ts` |
| Observação | `src/observability.ts`, `src/dashboard.ts`, `src/operations-observation.ts`, `ui/src` |
| Interfaces | `src/cli.ts`, `src/mcp.ts` |

Schemas de entrada são exportados pelos módulos responsáveis e usados pelas interfaces. As listas de comandos e ferramentas devem ser consultadas na versão instalada, pois podem aumentar em atualizações. Testes de contrato acompanham o núcleo; `npm run verify` executa os checks locais do pacote.

O projeto não mantém um segundo executor no frontend. A API de observação é loopback e de leitura. Publicação de segurança é uma capacidade separada e exige autoridade explícita. A execução local não incorpora automaticamente resultados de worktrees nem autoriza merge ou deploy.
