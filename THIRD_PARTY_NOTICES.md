# Proveniência e dependências

O núcleo e a camada de integração são código próprio do projeto. O helper compartilhado em `src/legacy/command-os-utils.js` foi incorporado de utilitário anterior do mesmo owner e ampliado aqui; sua lógica permanece centralizada.

O desenho do painel foi adaptado de uma referência fornecida pelo owner, cujo package.json declara MIT. O arquivo original, o template completo e ferramentas de coleta do material de referência não são redistribuídos. A UI contida aqui usa o núcleo local e os pacotes abaixo.

As dependências são instaladas pelos lockfiles. Seus códigos não são vendorizados. Licenças disponíveis nos pacotes instalados foram preservadas em `licenses/`; os metadados abaixo correspondem às versões fixadas.

| Pacote | Versão | Licença |
|---|---|---|
| @modelcontextprotocol/sdk | 1.30.0 | MIT |
| @openai/codex | 0.154.0 | Apache-2.0 |
| @types/node | 22.20.2 | MIT |
| typescript | 7.0.2 | Apache-2.0 |
| zod | 4.6.2 | MIT |
| @types/react | 19.3.0 | MIT |
| @types/react-dom | 19.3.0 | MIT |
| esbuild | 0.25.12 | MIT |
| lucide-react | 0.453.0 | ISC |
| react | 19.2.1 | MIT |
| react-dom | 19.2.1 | MIT |

Licenças transitivas acompanham os pacotes instalados e os metadados dos lockfiles. Atribuições originais desses pacotes não são substituídas pela condição de uso do código próprio.
