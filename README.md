# CodexInfra

Uma infraestrutura local de trabalho para o Codex: contexto de projetos, tarefas persistentes, execução com limites, workflows, evidências, aprendizado revisado e um painel de acompanhamento.

O fluxo começa na conversa. Você indica um objetivo; o coordenador carrega o contexto pertinente, escolhe execução direta, tarefa isolada ou workflow, verifica o resultado e preserva o que será útil na próxima retomada. O painel é a camada de consulta desse processo.

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

Requer Windows 11, Node.js 22.16 ou mais recente, npm, Git e Codex Desktop com acesso ao Codex. PowerShell 7 e Python 3 são necessários somente para o instalador de plugin pessoal. Dependências ficam dentro desta cópia; Docker e banco externo não são necessários.

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

`Configure-Local` registra apenas esta cópia da infraestrutura, com caminhos descobertos neste computador. Preserva registros existentes, gera a configuração MCP local ignorada pelo Git e aplica inicialmente 2 workers, até 1 de modelo simultâneo. Cada usuário mantém seu próprio estado e autenticação.

Instale o plugin pessoal após a configuração:

```powershell
pwsh -NoProfile -File scripts/Install-PersonalPlugin.ps1
```

O instalador reutiliza os helpers de `plugin-creator` fornecidos pelo Codex. Se não estiverem disponíveis, use a configuração MCP gerada em `plugins/codex-infra/.mcp.json` no cliente e siga [Instalação e operação](docs/USO.md). Abra uma nova tarefa para o cliente carregar o plugin atualizado.

Para tornar este caminho a regra do seu trabalho, peça ao Codex para incorporar [a instrução de adoção](docs/ADOPTION.md) ao seu contrato global existente. O instalador não substitui suas instruções e não importa suas conversas automaticamente. O bootstrap cria `docs/LOCAL-ADOPTION.md`, ignorado pelo Git, com a raiz desta instalação para esse ajuste.

## Primeira utilização

Peça: **“Cadastre este projeto na infraestrutura, com estas fontes e estes checks”**. Confira raiz, permissões e comandos. Depois use objetivos concretos, por exemplo: **“No projeto exemplo, corrija a validação de entrada e confirme com o teste cadastrado.”**

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
- [Como o workflow pessoal muda](docs/PROPOSTA.md)
- [Adoção no contrato do agente](docs/ADOPTION.md)
- [Privacidade e distribuição](docs/DISTRIBUICAO.md)
- [Arquitetura e referência do código](docs/ARQUITETURA.md)
- [Proveniência e dependências](THIRD_PARTY_NOTICES.md)
- [Condição de uso do código próprio](LICENSE)

Este repositório contém código e exemplos sanitizados. Perfis reais, conversas, credenciais, vaults, históricos, relatórios privados e cópias de recuperação ficam fora do Git.
