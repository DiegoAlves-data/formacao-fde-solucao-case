# ADR-001: Os nomes da base do kit espelham a fonte em português

- **Status:** accepted
- **Date:** 2026-11-15

## Context

A base do kit no Supabase (#52) guarda uma cópia fiel dos JSON de `data/kit/`. Os nomes dos arquivos e das chaves da fonte estão em português (`fornecedores`, `quantidade`, `preco_unitario`, `pedido_referenciado`, `nota_chave`) e são os mesmos do glossário do domínio (`docs/domain/glossary.md`). Os conectores simulados do plano #53 leem estas tabelas e falam a mesma língua do glossário. A regra de linguagem dos bastidores pede nomes em inglês.

## Decision

As tabelas `kit_*` e as colunas copiadas das chaves do kit mantêm o nome da fonte, em português, sem tradução. Cada linha da migração que declara uma delas leva `-- ADR-001`. Tudo o que o repositório inventa (código Python, arquivos de script, chaves estruturais do contrato de dados) tem nome em inglês; o texto para leitura segue em português.

## Consequences

- Quem lê a tabela encontra o mesmo nome do JSON, do glossário e do conector do #53; o carregador copia as chaves sem mapeamento.
- Renomear uma tabela ou coluna é mudança incompatível do contrato (`data/kit/contract.json`) e entra como migração nova.
- Os detectores de linguagem dos bastidores não cobram os nomes marcados com `ADR-001`; os demais seguem em inglês.

## Alternatives considered

- Traduzir tabelas e colunas para inglês e manter um mapeamento no carregador. Rejeitada: cria um dicionário a manter, afasta a base do glossário e do JSON, e o #53 passaria a ler nomes que ninguém mais usa.
