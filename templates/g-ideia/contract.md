## G-IDEIA — formalização e execução de projetos

Este contrato complementa as regras existentes do usuário. O vault de coding é a
fonte curada de engenharia; PRD/PREVC e as evidências do projeto orientam o trabalho.
A infraestrutura organiza contexto e execução, sem substituir essas fontes.

### Gatilho e autoridade

Acionar quando o usuário demonstrar intenção de formalizar, planejar, construir ou
acompanhar uma ideia/projeto. Conversa exploratória e pedido de nenhuma alteração
continuam somente leitura. Registrar uma interação não autoriza implementar seu
conteúdo. Perfil, plano, documento ou resultado de modelo não ampliam autorização
para publicação, merge, deploy, acesso a terceiros, compras ou exclusão.

### Processo

1. **G0 — Roteamento:** ler os contratos do host, do vault e do workspace; localizar
   fontes pertinentes. Consultar outros domínios quando aplicáveis. Produto para
   pessoas exige também fontes de produto/negócio. Fonte obrigatória indisponível
   mantém aberta a etapa afetada; informar a limitação concreta.
2. **G1 — Reconstrução:** em projeto existente, confrontar documentos, código, Git,
   testes e runtime aplicáveis. Separar fato observado, hipótese, decisão e incógnita.
   Não marcar implementação com base apenas em intenção ou no título de uma tarefa.
3. **G2 — Control Plane:** localizar o registro canônico antes de criar outro.
   Manter resumo, estado, fase PREVC, bloqueios, próxima ação e mapa das fontes.
4. **G3 — PRD:** definir problema, público/JTBD, objetivos e não objetivos, escopo,
   requisitos com IDs estáveis, jornadas, aceite, métricas, riscos, dependências,
   releases e questões abertas. Hipóteses de produto permanecem hipóteses.
5. **G4 — PREVC:** acompanhar P — Planning, R — Review, E — Execution,
   V — Validation, C — Confirmation. Cada fase contém responsável, entradas,
   entregáveis, evidências, gate de saída, bloqueios e próxima ação.
6. **G5 — Rastreabilidade:** vincular requisitos, itens PREVC, decisões, commits/PRs,
   testes e evidências. Distinguir conclusão de uma tarefa da conclusão do projeto.
7. **G6 — Confirmação:** conferir o estado vivo, atualizar os documentos canônicos,
   realizar o write-back exigido pelo vault e entregar referências verificáveis.

### Topologia e fontes

No vault, manter índice/estado do projeto e documentos separados de PRD, PREVC,
SPEC Técnica/ADRs e Evidências. O índice local funciona como Control Plane legível.
Projetos com negócio/produto mantêm sua contraparte no domínio correspondente.

Quando o contrato do ambiente exigir Notion, buscar os canônicos existentes antes
de publicar: Control Plane, PRD, PREVC Mestre, SPEC Técnica e ADRs, Negócio e Produto
quando aplicável, Evidências e Histórico Legado e database PREVC e Rastreabilidade.
Este database contém Task, Status, Priority, PREVC, Domain, Release, Requirement IDs,
Owner, Evidence e Source. Pesquisas/anexos adicionais ficam como descendentes do PRD,
com tipo, fonte, data e vínculo ao requisito/decisão. Markdown local não comprova
publicação ou sincronização no Notion; registrar a pendência quando necessária.

O Notion sintetiza o estado para pessoas. Vault, código, Git, testes, CI e runtime
continuam fontes de verdade em seus domínios. Não apagar/arquivar legado antes de
preservar conteúdo e validar links, filhos e evidências, e sem autorização específica.

### Profundidade e execução

Projeto pequeno/ferramenta interna pode usar conteúdo lean, mantendo as fases e a
separação dos artefatos. Ajustes pequenos usam o PRD/PREVC existente, sem gerar um
novo conjunto a cada bug. Marcar Não aplicável com razão onde um domínio não se aplicar.
Produto destinado a pessoas exige discovery, onboarding/ciclo de conta, privacidade,
suporte/administração, acessibilidade, confiança, monetização/pricing/GTM, retenção,
operação, unit economics, propriedade intelectual e questões legais/comerciais
pertinentes. Uso do próprio autor não equivale a validação de mercado.

Antes de dividir uma implementação complexa por camadas, considerar a menor fatia
ponta a ponta que verifique o comportamento necessário. Registrar entrada, resultado
observável, dependências, aceite e validação; aplicar profundidade proporcional.

Antes de implementar, confirmar PRD/PREVC vigentes e o requisito/item autorizado.
Fontes obrigatórias entram em `taskDetails.requiredSourceLabels` com labels exatos do
perfil; `requirementIds` e `decisionRefs` mantêm rastreabilidade. Ler trechos decisivos
completos quando truncados. Trabalho direto obedece às mesmas fontes e limites.
Falta material de escopo bloqueia a implementação afetada; planejamento autorizado
pode formalizar os documentos antes da solução. Fixtures técnicas próprias mantêm
seu contrato de teste delimitado, sem dispensar o método nos projetos reais.

Done exige artefato identificável, versão/estado exato, método de validação e resultado.
Teste verde, merge ou deploy não substituem os demais gates do projeto. Atualizar o
PREVC e o write-back após conferir evidências. Candidatos de aprendizado exigem fonte,
revisão, validação e promoção autorizada; não alteram estas regras automaticamente.
