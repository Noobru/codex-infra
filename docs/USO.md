# Instalação e operação

## Configuração

Execute os comandos de instalação do README dentro da cópia clonada. `Configure-Local.mjs` usa o `TaskEngine`, o `ProfileManager` e a política canônica para cadastrar somente `codex-infra`. A configuração contém caminhos desta instalação e fica fora do Git. Repetir configuração idêntica é seguro; definição existente diferente exige revisão explícita, não substituição silenciosa.

O plugin pessoal usa o identificador `codex-infra`. O instalador requer os helpers `plugin-creator` presentes no Codex e Python 3; parâmetros `-PluginCreatorRoot` e `-PythonPath` permitem indicar instalações existentes. Para atualização já instalada, use `-Update`. O instalador preserva marketplaces e destinos diferentes, valida caminhos e registra um recibo local.

Se configurar MCP manualmente, use o objeto gerado em `plugins/codex-infra/.mcp.json`. Ele inicia `dist/src/mcp.js` com o Node local e `CODEX_INFRA_ROOT` correspondente. Não publique esse arquivo gerado. A autenticação com Codex pertence ao usuário: use o login do cliente ou `node node_modules/@openai/codex/bin/codex.js login`. O setup não cria chave de API nem migra autenticação.

## Cadastrar um projeto

Peça ao agente para produzir o perfil de acordo com `ProfileSchema` em `src/registry.ts`. Revise ID/aliases, raiz existente, estado, modos, fontes, checks e workspaces. Cada check tem executável, argumentos, diretório relativo e declaração `readOnly` compatível com seu efeito real. Fontes adicionais exigem raízes permitidas explícitas.

```powershell
node dist/src/cli.js register --file profile.local.json
node dist/src/cli.js projects
node dist/src/cli.js context --project projeto-exemplo
```

Não versionar `profile.local.json`. Cadastro não executa os comandos do projeto nem instala seu ambiente. Produtos pausados conservam seus limites.

## Preparar e executar

Uma entrada de tarefa contém `project`, `objective`, `idempotencyKey`, `mode`, `kind` e `checkIds`. Pode incluir requisitos, critérios de aceite, restrições, fontes obrigatórias, decisões, dependências e roteamento. Use uma chave estável para a mesma solicitação e uma nova chave para outro contrato.

```powershell
node dist/src/cli.js task-context --file task.local.json
node dist/src/cli.js prepare --file task.local.json
node dist/src/cli.js run JOB_ID --timeout 300000
node dist/src/cli.js status JOB_ID
```

`kind: checks` executa checks cadastrados. `kind: codex` usa um worker e depois os checks; consome o acesso da conta. `workspace: worktree` exige `baseRef` local explícito, fixado em SHA na preparação. Mudança de arquivo exige modo permitido e autorização da tarefa.

## Concorrência e workflows

O bootstrap aplica 2 workers, até 1 de modelo. Consulte `execution-policy`; alterações exigem workers ociosos. Há limite de até quatro workers e o limite de modelo não supera o total. Raízes iguais ou sobrepostas disputam o mesmo recurso. Worktrees distintas permitem trabalho independente.

`WorkflowInputSchema` em `src/workflow.ts` define objetivo, chave, nós `id`/`dependsOn`/`task` e limite de revisões. O agente usa `prepare_workflow` e `run_workflow` ou `start_workflow`. Preparar não executa. Cada plano despacha apenas seus jobs e repassa evidências das dependências. Uma falha exige diagnóstico e revisão explícita; nós concluídos são preservados.

Para fila sem DAG, selecione IDs e limites deliberadamente:

```powershell
node dist/src/cli.js start-queue --jobs JOB_1,JOB_2 --max-jobs 2 --concurrency 2 --timeout 300000
node dist/src/cli.js queue-status SUPERVISOR_ID
node dist/src/cli.js stop-queue SUPERVISOR_ID
```

O supervisor é temporário, oculto e limitado. Não há reinício automático nem novos objetivos criados por ele.

## Falha e retomada

Consulte status, tentativas e artefatos antes de retry. `cancel JOB_ID` solicita parada; timeout do cliente não comprova encerramento. `reconcile` identifica owners ausentes e estaciona trabalho para revisão. `retry` é explícito e preserva tentativas anteriores. Cleanup desconhecido exige inspeção real antes de liberar o recurso.

## Contexto e aprendizado

Contexto atual, conhecimento promovido e grafo entram no caminho canônico de preview/prepare/run. Não é necessário indexar manualmente antes de cada tarefa. Fontes obrigatórias, validade, precedência, conflito, orçamento e truncamento permanecem explícitos. Referência não ganha autoridade por entrar no contexto.

O ciclo de aprendizado usa `propose_learning`, `review_learning`, `learning_shadow_source`, `validate_learning`, `promote_learning` e `revert_learning`. A proposta deve estar ligada a uma tentativa real ou a uma revisão imutável de interação, a validação deve incluir os bytes exatos da proposta e a promoção exige decisão documentada do owner. Uma prática promovida alimenta contexto futuro; não instala scripts globais nem os executa automaticamente.

## Segurança e recuperação

`security_report` consome relatórios existentes, com enriquecimento opcional `feeds.mode: enrich`. Feeds indisponíveis preservam informação desconhecida. A publicação GitHub usa dry-run por padrão; envio real exige configuração, credencial de ambiente e autorização exata/fresca. Essa ferramenta não faz scan, patch ou deploy.

`snapshot` e `restore` usam destinos novos. Faça restauração em outra pasta, valide o manifesto, reconcilie owners e ative apenas os perfis escolhidos após revisar caminhos. A cópia inclui estado e artefatos privados: **não a use como pacote de distribuição**. Node/npm, dependências, autenticação e vínculos de plugin são reconstruídos na máquina de destino.

## Validação local

`npm run verify` executa build, a suíte completa do núcleo e typecheck/build da UI, preservando um recibo na área local de artefatos. Não gera uma tarefa de modelo e não publica no GitHub. Após alterações posteriores no candidato, revalide antes de um push.
