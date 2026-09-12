# CodexInfra

Uma infraestrutura local de trabalho para o Codex: contexto de projetos, tarefas persistentes, execução com limites, workflows, evidências, aprendizado revisado e um painel de acompanhamento.

O fluxo começa na conversa e no discovery. Ao formalizar ou executar engenharia, o coordenador carrega o vault de coding e seus contratos, aplica o G-IDEIA, mantém PRD/PREVC e as referências técnicas pertinentes, escolhe execução direta, tarefa isolada ou workflow, valida o resultado e faz o write-back. O painel é a camada de consulta desse processo.

**Esta distribuição pressupõe um vault de coding equivalente já disponível**, com práticas curadas e contratos de agentes. Ele é a fonte básica de verdade de engenharia; deve ser configurado para cada destinatário. O G-IDEIA existente é preservado; quando faltar, o bootstrap complementar permite adotá-lo com método e templates. O pacote não inclui o vault pessoal do autor nem cria uma base vazia para substituí-lo. Consulte [Contrato de contexto](docs/CONTEXT-CONTRACT.md) antes do primeiro trabalho de engenharia.

## O que vem nesta distribuição

| Capacidade | Comportamento disponível |
|---|---|
| Contexto | Perfis explícitos, fontes com proveniência, seleção por tarefa e grafo de links locais. |
| Execução | Estado em SQLite, checks nomeados, tentativas, cancelamento, recuperação e worktrees isoladas. |
| Coordenação | Limites de workers e modelos, DAG de dependências, repasses de evidências e replanejamento limitado. |
| Aprendizado | Proposta ligada a uma execução, revisão, validação pequena, promoção explícita e reversão. |
| Segurança | Leitura de relatórios, enriquecimento opcional OSV/KEV e publisher GitHub com autorização por destino/SHA. |
| Observação | Seis telas sobre o estado real, com navegação para tarefas e evidências. |
| Integração | CLI e MCP compartilham o mesmo núcleo. Plugin e instrução de adoção acompanham o código. |

## Instalação inicial no Windows

Requer Windows 11, Node.js 22.16 ou mais recente, npm, Git e Codex Desktop com acesso ao Codex, além do vault de coding e dos contratos compatíveis descritos acima. PowerShell 7 e Python 3 são necessários somente para o instalador de plugin pessoal. Dependências ficam dentro desta cópia; Docker e banco externo não são necessários.

Na pasta deste repositório:

```powershell
npm ci
npm run build
npm --prefix ui ci
npm --prefix ui run build
node scripts/Configure-Local.mjs
node dist/src/cli.js doctor --project codex-infra
npm run verify
```

`Configure-Local` registra apenas esta cópia da infraestrutura, com caminhos descobertos neste computador. Preserva registros existentes, gera a configuração MCP local ignorada pelo Git e aplica inicialmente 2 workers, até 1 de modelo simultâneo. Esse bootstrap e o `doctor` verificam a instalação; não atestam que o vault ou um projeto está preparado para engenharia. Cada usuário configura suas fontes e mantém seu próprio estado e autenticação.

Prepare `bootstrap.local.json` com o vault existente e, opcionalmente, os dados do projeto conforme [Contrato de contexto](docs/CONTEXT-CONTRACT.md). O bootstrap G-IDEIA tem preview e aplicação explícita:

```powershell
node scripts/Bootstrap-GIdeia.mjs --input bootstrap.local.json
node scripts/Bootstrap-GIdeia.mjs --input bootstrap.local.json --apply
```

O preview não grava nem executa projeto. A aplicação preserva as instruções existentes, adota o contrato complementar quando necessário e pode criar a estrutura documental e o perfil do projeto. Os documentos gerados precisam de conteúdo e revisão; sua criação não declara Planning, execução ou validação concluídos.

Instale o plugin pessoal após a configuração:

```powershell
pwsh -NoProfile -File scripts/Install-PersonalPlugin.ps1
```

O instalador reutiliza os helpers de `plugin-creator` fornecidos pelo Codex. Se não estiverem disponíveis, use a configuração MCP gerada em `plugins/codex-infra/.mcp.json` no cliente e siga [Instalação e operação](docs/USO.md). Abra uma nova tarefa para o cliente carregar o plugin atualizado.

Para tornar este caminho a regra do seu trabalho, peça ao Codex para incorporar [a instrução de adoção](docs/ADOPTION.md) ao seu contrato global existente. O instalador não substitui suas instruções e não importa suas conversas automaticamente. O bootstrap cria `docs/LOCAL-ADOPTION.md`, ignorado pelo Git, com a raiz desta instalação para esse ajuste.

## Primeira utilização

Peça: **“Carregue o contrato do meu vault de coding, localize o PRD/PREVC canônico deste projeto e cadastre suas fontes e checks na infraestrutura.”** Confira raiz, fontes, permissões e comandos. Depois use objetivos concretos, por exemplo: **“No projeto exemplo, corrija a validação de entrada dentro do requisito existente e confirme com o teste cadastrado.”**

Em projeto existente, reaproveite e atualize PRD/PREVC canônicos. Um bug pequeno não exige criar outro PRD a cada tarefa. Em ideia nova, conversa e discovery precedem a formalização proporcional exigida pelo G-IDEIA. Registrar a conversa não substitui esse contrato nem autoriza implementar.

Selecionar um projeto sem objetivo apenas carrega contexto. A execução direta continua disponível para trabalho simples; persistência e workers entram quando ajudam a execução, a retomada ou o isolamento. Publicação, merge, deploy e promoção de conhecimento respeitam suas autorizações.

Para abrir o painel temporário:

```powershell
node dist/src/cli.js observe --port 4317 --timeout 7200000
```

Acesse o endereço loopback exibido no terminal. O painel consulta estado; seus cards não iniciam tarefas.

## Ganhos esperados e mudança de hábito

O objetivo é reduzir a reconstrução de contexto, o retrabalho e a supervisão manual, além de aproveitar melhor a cota disponível. **São hipóteses de benefício ainda não verificadas**: não há percentual de economia, ganho de produtividade ou melhoria de qualidade estabelecido para esta distribuição.

O mecanismo e o novo fluxo estão detalhados em [Proposta e hipóteses](docs/PROPOSTA.md). O uso contínuo mostra se essas mudanças ajudam no seu trabalho; o registro de evidências permite comparar experiências sem transformar estimativas em medições.

## Documentação

- [Instalação, cadastro, comandos e recuperação](docs/USO.md)
- [Vault, G-IDEIA e fontes obrigatórias](docs/CONTEXT-CONTRACT.md)
- [Como o workflow pessoal muda](docs/PROPOSTA.md)
- [Adoção no contrato do agente](docs/ADOPTION.md)
- [Privacidade e distribuição](docs/DISTRIBUICAO.md)
- [Arquitetura e referência do código](docs/ARQUITETURA.md)
- [Proveniência e dependências](THIRD_PARTY_NOTICES.md)
- [Condição de uso do código próprio](LICENSE)

Este repositório contém código e exemplos sanitizados. Perfis reais, conversas, credenciais, vaults, históricos, relatórios privados e cópias de recuperação ficam fora do Git.
