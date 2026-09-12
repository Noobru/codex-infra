# Fixture Python — normalização de rótulos

Fixture artificial, somente leitura, para verificar outro runtime por meio do mesmo TaskEngine. Não representa um produto real.

O pequeno transformador remove espaços nas extremidades, normaliza caixa, ignora rótulos vazios e remove duplicatas preservando a ordem. Seus testes usam somente a biblioteca padrão.

Check canônico da cópia: `python -B -m unittest -v test_transform.py`. O runner exige um Python local já disponível; não instala runtime, pacotes ou dependências. Nenhum modelo altera esta fixture.
