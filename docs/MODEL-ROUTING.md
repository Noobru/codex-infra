# Qualificação e dispatch de agentes

O orquestrador interpreta a tarefa e fornece uma qualificação completa, incluindo
a razão observada. O Infra aplica a política configurada; não classifica por título
nem cria uma chamada de modelo apenas para classificar. O usuário define o objetivo.

| Necessidade delimitada e verificável | Seleção inicial |
| --- | --- |
| Busca ou check determinístico | Ferramenta direta, sem modelo |
| Retrieval simples com seleção semântica | Luna / low |
| Implementação simples | Luna / medium |
| Pesquisa ou review simples | Sol / medium |
| Análise ou implementação moderada separável | Sol / high |
| Alta complexidade, risco, incerteza ou acoplamento | Coordenador configurado |
| Segurança defensiva autorizada | Daybreak Blue / high |

`profiles/model-routing.json` centraliza modelos e esforços. O coordenador inicial é
Astra/ultra; a decisão de manter trabalho nele não exige criar outro worker. Uma
escolha explícita do owner pode sobrepor a seleção nos limites do contrato defensivo.
Se o owner escolher só o modelo, o esforço continua derivado da qualificação da tarefa.
Essa matriz é hipótese operacional; não prova qualidade nem economia de cota.

Se o arquivo estiver ausente, o pacote usa essa mesma matriz de fábrica; a entrada
expõe `configurationSource: built-in-default`. Um arquivo inválido é erro, sem
fallback. Checks determinísticos independem da configuração de modelo. A política
salva continua sendo a fonte da execução, mesmo se o arquivo mudar depois.

## Caminho canônico

`delegate_task` (CLI: `delegate --file INPUT.json`) recebe projeto, objetivo, modo,
checks, detalhes de aceite, chave idempotente e `qualification`. A qualificação
exige classe, complexidade, incerteza, risco, acoplamento, limites, verificabilidade,
benefício esperado/observado e justificativa. O orquestrador preenche esses campos.

O comando reutiliza `TaskEngine.prepare` e `run`: salva a qualificação, snapshot/hash
da política e decisão; admite o job nos limites compartilhados; valida o catálogo;
envia modelo/esforço explícitos em `thread/start` e `turn/start`; confere os valores
efetivos e retorna job, decisão, execução e diretório de evidências. Indisponibilidade
ou divergência bloqueia antes de gerar, sem fallback automático para Ultra.
Se a qualificação indicar o coordenador, `delegate_task` recusa antes de criar job:
o orquestrador continua nessa conversa. Preparação persistente explícita mantém
suporte a workers complexos para workflows e retomadas autorizados.

`route_task` é preview; não despacha. Fila e workflow usam a mesma qualificação no
campo `routing` da task e o mesmo executor. Alterar a configuração só afeta novas
preparações: uma chave idempotente não pode trocar silenciosamente a política salva.
Jobs legados sem qualificação/política não são retomados automaticamente.

## Limite do Desktop

O plugin instrui o coordenador a usar esse caminho. Não existe aqui um hook sobre
`collaboration.spawn_agent` nativo do Desktop. Uma sessão que ainda carregue a skill
ou o MCP anterior precisa de um novo thread após reinstalação. A versão instalada
sozinha não prova reload do processo já aberto.

Os receipts reais dos workers provam a seleção do Infra. Testes de transporte falso
protegem a transmissão e bloqueios; não substituem a prova real de execução ou a
validação do resultado pelo coordenador.
