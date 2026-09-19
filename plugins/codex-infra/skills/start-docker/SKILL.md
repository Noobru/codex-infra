---
name: start-docker
description: Entrada principal para abrir ou recuperar Docker Desktop no Windows, em qualquer projeto ou tarefa sem projeto. Use antes de iniciar Docker para testes, builds, Compose, containers ou CI local, e para erros de sockets sailor-ingest.sock ou engine.sock. Reutiliza o preflight e o recuperador canônicos do host.
---

# Abrir Docker pelo fluxo do host

Use esta skill antes de qualquer abertura do Docker Desktop pelo agente, mesmo
quando ele ainda não apresentou erro. Ela pertence ao host, não ao projeto que
será testado. Preserve projeto, objetivo, tarefa e CWD; não selecione codex-infra
para conseguir usar Docker. As ferramentas abaixo não exigem projeto registrado.

1. Chame `inspect_docker_recovery` antes de tentar iniciar. Se `healthy:true`, use
   o engine existente e continue o trabalho; não abra outra instância.
2. Se `docker-active`, acompanhe a saúde sem repetir a abertura. Processos ativos
   com falha exigem diagnóstico e a autorização correspondente para encerramento.
   Se `manual-inspection`, inspecione o conteúdo inesperado; não limpe sockets.
3. Se `docker-stopped` ou `orphan-sockets` e houver autorização de abertura já
   recebida, chame `recover_docker_start` com a referência real dessa autorização:

   ```json
   {"decision":{"author":{"name":"Owner","role":"owner"},"source":"Referência real do pedido que autoriza iniciar Docker","evidence":["Referência da inspeção atual"]}}
   ```

   Reutilize a autorização da conversa; não peça outra só porque mudou de projeto.
   A escolha desta skill, sozinha, não autoriza iniciar ou encerrar serviços.
4. O recuperador revalida a saúde, preserva as duas pastas conhecidas quando há
   sockets órfãos e inicia uma única vez. Depois, confirme `healthy:true` em nova
   inspeção. `starting-or-failed` exige acompanhar/diagnosticar; não repetir start.

Não substitua esse fluxo por `Start-Process`, abertura direta de
`Docker Desktop.exe`, `docker desktop start` ou um helper de recuperação paralelo.
A janela oculta não substitui o preflight. Não faça reset, shutdown do WSL ou
limpeza de imagens, volumes e discos como parte da abertura.

Se o MCP estiver indisponível ou desatualizado, use a mesma implementação pela CLI
da instalação CodexInfra, sem mudar o projeto do trabalho:

```text
node <infra-root>/dist/src/cli.js docker-recovery
node <infra-root>/dist/src/cli.js docker-recovery --file <decision.json>
```

O primeiro comando só inspeciona; o segundo usa a decisão real de abertura. Não
crie arquivo de decisão em pedido somente leitura. Se ambas as interfaces
falharem, registre o erro; não use uma abertura direta como fallback.

Recuperação e recibos são implementados em `src/docker-recovery.ts` e
`scripts/Docker-SocketRecovery.ps1`. Detalhes em `docs/DOCKER-RECOVERY.md`, na raiz
da instalação. O interpretador aprendido de recibos é auxiliar e não é requisito
para esta abertura. Workbenches de aprendizado continuam sem autoridade para
iniciar Docker/WSL; devem devolver a necessidade ao coordenador do host.
