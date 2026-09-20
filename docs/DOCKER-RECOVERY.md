# Abrir e recuperar Docker Desktop no Windows

A skill instalada `start-docker` é a entrada principal antes de qualquer abertura
pelo agente, para todos os projetos e tarefas sem projeto. `start-project`,
`enter_interaction.hostOperations.docker` e os workers comuns apontam para o mesmo
procedimento. Não é necessário selecionar o projeto codex-infra nem executar um
bundle aprendido. O projeto consumidor conserva sua identidade e autoridade.

Use o recuperador abaixo também na abertura normal; ele não faz quarentena quando
não há sockets órfãos e não reinicia um engine saudável. Não substitua o fluxo por
`Start-Process`, abertura direta de `Docker Desktop.exe` ou `docker desktop start`.
Esses comandos ficam encapsulados na implementação canônica. A skill orienta o
agente; não instala um interceptador de comandos no aplicativo.

O preflight reconhece a falha `The file cannot be accessed by the system` ao
renomear sockets de `Docker/run` ou `docker-secrets-engine`. A ocorrência observada
em Docker Desktop 4.90.0 deixou reparse points de tamanho zero após encerrar o
backend. A causa interna no Docker/Windows não foi estabelecida.

## Fluxo operacional

1. `node dist/src/cli.js docker-recovery` ou `inspect_docker_recovery`: somente
   leitura. Confere processos, inventário restrito, assinatura do erro no log e
   resposta do engine Linux local. Não lê conteúdos de secrets nem inicia serviços.
   Entradas de socket conhecidas sem processos proprietários são preservadas antes
   da abertura mesmo que o log anterior tenha sido rotacionado; não é necessário
   provocar novamente o crash para diagnosticar esses resíduos.
2. Se Docker está ativo, aguarde a inicialização ou encerre a instância com a
   autorização correspondente. Não manipule os sockets enquanto há processos.
3. Com autorização explícita já recebida para recuperar/iniciar, use
   `recover_docker_start({decision:{author:{name:"Owner",role:"owner"},source:
   "Referência da autorização",evidence:["Referência do diagnóstico"]}})` ou
   `docker-recovery --file DECISION.json`.
4. O fluxo preserva as duas pastas conhecidas com sufixo único `.recovery-UUID`
   antes de iniciar uma única vez. Recusa arquivos desconhecidos, diretórios
   redirecionados e processos ativos. Não exclui arquivos, redefine o Docker,
   altera WSL, configurações, imagens, volumes ou discos virtuais.
5. Confira novamente `inspect_docker_recovery`. Só `healthy:true` comprova a
   resposta do engine. `starting-or-failed` não é sucesso nem autoriza repetição
   cega. Leia o erro atual se o engine não responder.

Recibos imutáveis ficam em `artifacts/integration/docker-recovery/UUID`:
intenção antes da mutação, pastas preservadas e resultado/falha. Uma falha parcial
preserva a intenção e as pastas já renomeadas; inspecione-as antes de retomar.
A quarentena existe para investigação/retomada; limpeza posterior é uma ação
separada e deve respeitar a aprovação do host. Não acumular tentativas em loop.

O sandbox automático de aprendizado continua exigindo Docker previamente ativo.
Esta recuperação é uma capacidade operacional do host, não um bundle com poder
de iniciar serviços dentro do sandbox. O agente deve usar este preflight antes
de abrir Docker em tarefas autorizadas. Uma nova ocorrência desconhecida continua
exigindo diagnóstico, em vez de aplicar esta receita indiscriminadamente.

## Limite de plataforma local

Este procedimento é exclusivo do Windows. No macOS, mantenha o Colima existente;
esta atualização não autoriza iniciar, parar ou alterar serviços nem criar backend
alternativo. Não trate o fluxo Windows como instrução operacional para Colima.

Referências: [Docker Desktop CLI](https://docs.docker.com/desktop/features/desktop-cli/),
[start](https://docs.docker.com/reference/cli/docker/desktop/start/),
[stop](https://docs.docker.com/reference/cli/docker/desktop/stop/).
