# Privacidade e distribuição

O pacote compartilhável é produzido por uma lista explícita de arquivos de código, testes, UI, exemplos e documentação. Nunca se publica uma cópia recursiva da instalação em uso.

## Conteúdo privado fora do Git

Perfis e caminhos configurados, banco SQLite, histórico de interações, logs, artefatos, snapshots, restaurações, worktrees, credenciais, configuração MCP local e instruções pessoais geradas permanecem ignorados. O arquivo `.gitignore` é uma prevenção adicional; revisar o candidato antes do commit continua necessário.

O código usa os caminhos configurados localmente. O bootstrap descobre a pasta de instalação e o executável Node no computador receptor, sem transportar diretórios do autor. O pacote inicia sem projetos pessoais cadastrados e sem importar conversas.

A distribuição pressupõe que o destinatário já tenha um vault de coding equivalente, conforme [Contrato de contexto](CONTEXT-CONTRACT.md). O módulo G-IDEIA oferece método e templates para adoção complementar quando o contrato ainda faltar. O vault pessoal do autor não é distribuído. Cada usuário conecta seus próprios contratos, PRD/PREVC e práticas; o setup não cria um vault sintético nem declara essa compatibilidade automaticamente.

As fixtures de teste são artificiais. Strings de segredo, endereços de exemplo e caminhos usados nos testes de redação não representam credenciais ou projetos reais. Licenças de dependências conservam as atribuições originais.

## Dados durante o uso

Contexto e comandos autorizados podem ser enviados ao provedor de modelo utilizado pelo Codex. Armazenamento local não transforma a geração cloud em processamento exclusivamente offline. Relatórios e fontes podem conter informação sensível; selecione apenas o necessário e respeite as regras do projeto.

O publisher não recebe token no perfil. A variável `CODEX_INFRA_GITHUB_TOKEN`, quando usada, pertence ao ambiente local e não deve ser salva no Git. Publicação requer destino, SHA, estágio e autoridade correspondentes. O modo padrão é dry-run.

## Atualizações e compartilhamento

Cada destinatário instala sua própria cópia, autentica sua conta e cadastra seus projetos. O repositório privado não concede acesso automático a terceiros; somente o owner pode convidá-los. Não há sincronização automática dos históricos dos participantes.

Esta distribuição não contém workflows do GitHub Actions. A validação é local por `npm run verify`, antes de qualquer push; o candidato revisado deve permanecer o mesmo até a publicação. A ausência de workflows evita disparos de Actions por push/PR deste pacote.

Extensões ligadas exclusivamente a ambientes pessoais ficam fora da distribuição. O executor genérico de checks continua disponível para registrar a CI aplicável a cada projeto.
