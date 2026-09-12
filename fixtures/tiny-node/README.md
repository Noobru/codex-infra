# Fixture Node — limite de pontuação

Fixture artificial para validar o fluxo da infraestrutura. Não representa um produto real nem evidência de economia ou aceite humano.

`clampScore(value)` aceita somente números finitos, limita valores ao intervalo fechado de 0 a 100 e preserva frações dentro desse intervalo. Valores não numéricos, `NaN` e infinitos devem gerar `TypeError`.

A fonte contém deliberadamente uma falha no limite superior. O teste `upper bound is 100` deve falhar na baseline. A execução de aceitação copia esta fixture para um diretório novo; a fonte em `fixtures/` deve permanecer intacta.

Na correção autorizada, altere somente `clamp.mjs` da cópia. Preserve `clamp.test.mjs`, este README e `baseline-checks.json`. Não instale dependências, crie arquivos, acesse a rede, execute outro projeto, use outro modelo/agente ou altere a infraestrutura. O runner externo executará os checks após a correção; não é necessário rodar comandos para cumprir a pequena alteração.

Check canônico da cópia: `node --test --test-reporter=tap clamp.test.mjs`.
