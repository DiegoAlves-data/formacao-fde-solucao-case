-- Base do kit: tabelas que espelham os JSON de data/kit/ (ver data/kit/contract.json, #52).
-- RLS ligado em toda tabela e nenhuma política: só o Worker lê, com a chave secreta (#52).

-- ERP (cadastro): fornecedores.json (#52)
create table public.kit_fornecedores ( -- ADR-001
  fornecedor_id text not null, -- ADR-001
  razao_social text not null, -- ADR-001
  cnpj text not null, -- ADR-001
  bloqueado boolean not null, -- ADR-001
  motivo_bloqueio text not null, -- ADR-001
  constraint kit_fornecedores_pkey primary key (fornecedor_id) -- ADR-001
);
alter table public.kit_fornecedores enable row level security; -- ADR-001

-- ERP (cadastro): produtos.json (#52)
create table public.kit_produtos ( -- ADR-001
  sku text not null, -- ADR-001
  descricao text not null, -- ADR-001
  fornecedor_id text not null, -- ADR-001
  codigo_fornecedor text not null, -- ADR-001
  unidade_base text not null, -- ADR-001
  fator_caixa integer not null, -- ADR-001
  preco_referencia_un numeric(12,2) not null, -- ADR-001
  constraint kit_produtos_pkey primary key (sku), -- ADR-001
  constraint kit_produtos_fornecedor_id_fkey foreign key (fornecedor_id) references public.kit_fornecedores (fornecedor_id) -- ADR-001
);
alter table public.kit_produtos enable row level security; -- ADR-001

-- ERP (compras): ordens.json (#52)
create table public.kit_ordens ( -- ADR-001
  ordem_id text not null, -- ADR-001
  fornecedor_id text not null, -- ADR-001
  destino text not null, -- ADR-001
  data_emissao date not null, -- ADR-001
  status text not null, -- ADR-001
  motivo_status text not null, -- ADR-001
  valor_total numeric(14,2) not null, -- ADR-001
  constraint kit_ordens_pkey primary key (ordem_id), -- ADR-001
  constraint kit_ordens_fornecedor_id_fkey foreign key (fornecedor_id) references public.kit_fornecedores (fornecedor_id), -- ADR-001
  constraint kit_ordens_check1 check (status in ('aberta', 'atendida', 'travada')) -- ADR-001
);
alter table public.kit_ordens enable row level security; -- ADR-001

-- ERP (compras): ordens.json (#52)
create table public.kit_ordem_itens ( -- ADR-001
  ordem_id text not null, -- ADR-001
  codigo_fornecedor text not null, -- ADR-001
  sku text, -- ADR-001
  descricao text not null, -- ADR-001
  quantidade integer not null, -- ADR-001
  unidade text not null, -- ADR-001
  preco_unitario numeric(12,2) not null, -- ADR-001
  constraint kit_ordem_itens_pkey primary key (ordem_id, codigo_fornecedor), -- ADR-001
  constraint kit_ordem_itens_ordem_id_fkey foreign key (ordem_id) references public.kit_ordens (ordem_id), -- ADR-001
  constraint kit_ordem_itens_sku_fkey foreign key (sku) references public.kit_produtos (sku) -- ADR-001
);
alter table public.kit_ordem_itens enable row level security; -- ADR-001

-- SEFAZ: notas.json (#52)
create table public.kit_notas ( -- ADR-001
  chave text not null, -- ADR-001
  nota_id text not null, -- ADR-001
  numero integer not null, -- ADR-001
  serie integer not null, -- ADR-001
  fornecedor_id text not null, -- ADR-001
  destino text not null, -- ADR-001
  data_emissao date not null, -- ADR-001
  pedido_referenciado text, -- ADR-001
  canal_entrada text not null, -- ADR-001
  valor_total numeric(14,2) not null, -- ADR-001
  constraint kit_notas_pkey primary key (chave), -- ADR-001
  constraint kit_notas_fornecedor_id_fkey foreign key (fornecedor_id) references public.kit_fornecedores (fornecedor_id), -- ADR-001
  constraint kit_notas_pedido_referenciado_fkey foreign key (pedido_referenciado) references public.kit_ordens (ordem_id), -- ADR-001
  constraint kit_notas_nota_id_key unique (nota_id) -- ADR-001
);
alter table public.kit_notas enable row level security; -- ADR-001

-- SEFAZ: notas.json (#52)
create table public.kit_nota_itens ( -- ADR-001
  chave text not null, -- ADR-001
  codigo_fornecedor text not null, -- ADR-001
  sku text, -- ADR-001
  descricao text not null, -- ADR-001
  quantidade integer not null, -- ADR-001
  unidade text not null, -- ADR-001
  preco_unitario numeric(12,2) not null, -- ADR-001
  valor numeric(14,2) not null, -- ADR-001
  constraint kit_nota_itens_pkey primary key (chave, codigo_fornecedor), -- ADR-001
  constraint kit_nota_itens_chave_fkey foreign key (chave) references public.kit_notas (chave), -- ADR-001
  constraint kit_nota_itens_sku_fkey foreign key (sku) references public.kit_produtos (sku) -- ADR-001
);
alter table public.kit_nota_itens enable row level security; -- ADR-001

-- ERP (contas a pagar): notas_lancadas.json (#52)
create table public.kit_notas_lancadas ( -- ADR-001
  chave text not null, -- ADR-001
  nota_id text, -- ADR-001
  numero integer not null, -- ADR-001
  serie integer not null, -- ADR-001
  fornecedor_id text not null, -- ADR-001
  destino text not null, -- ADR-001
  data_emissao date not null, -- ADR-001
  pedido_referenciado text not null, -- ADR-001
  canal_entrada text not null, -- ADR-001
  valor_total numeric(14,2) not null, -- ADR-001
  situacao text not null, -- ADR-001
  constraint kit_notas_lancadas_pkey primary key (chave), -- ADR-001
  constraint kit_notas_lancadas_fornecedor_id_fkey foreign key (fornecedor_id) references public.kit_fornecedores (fornecedor_id), -- ADR-001
  constraint kit_notas_lancadas_pedido_referenciado_fkey foreign key (pedido_referenciado) references public.kit_ordens (ordem_id), -- ADR-001
  constraint kit_notas_lancadas_check1 check (situacao in ('lançada', 'paga')) -- ADR-001
);
alter table public.kit_notas_lancadas enable row level security; -- ADR-001

-- ERP (contas a pagar): notas_lancadas.json (#52)
create table public.kit_nota_lancada_itens ( -- ADR-001
  chave text not null, -- ADR-001
  codigo_fornecedor text not null, -- ADR-001
  sku text, -- ADR-001
  descricao text not null, -- ADR-001
  quantidade integer not null, -- ADR-001
  unidade text not null, -- ADR-001
  preco_unitario numeric(12,2) not null, -- ADR-001
  valor numeric(14,2) not null, -- ADR-001
  constraint kit_nota_lancada_itens_pkey primary key (chave, codigo_fornecedor), -- ADR-001
  constraint kit_nota_lancada_itens_chave_fkey foreign key (chave) references public.kit_notas_lancadas (chave), -- ADR-001
  constraint kit_nota_lancada_itens_sku_fkey foreign key (sku) references public.kit_produtos (sku) -- ADR-001
);
alter table public.kit_nota_lancada_itens enable row level security; -- ADR-001

-- banco: pagamentos.json (#52)
create table public.kit_pagamentos ( -- ADR-001
  pagamento_id text not null, -- ADR-001
  fornecedor_id text not null, -- ADR-001
  destino text not null, -- ADR-001
  data date not null, -- ADR-001
  valor numeric(14,2) not null, -- ADR-001
  forma text not null, -- ADR-001
  origem text not null, -- ADR-001
  nota_chave text, -- ADR-001
  constraint kit_pagamentos_pkey primary key (pagamento_id), -- ADR-001
  constraint kit_pagamentos_fornecedor_id_fkey foreign key (fornecedor_id) references public.kit_fornecedores (fornecedor_id) -- ADR-001
);
alter table public.kit_pagamentos enable row level security; -- ADR-001

-- WMS e app de loja: recebimentos.json (#52)
create table public.kit_recebimentos ( -- ADR-001
  recebimento_id text not null, -- ADR-001
  nota_chave text, -- ADR-001
  ordem_id text, -- ADR-001
  fornecedor_id text not null, -- ADR-001
  destino text not null, -- ADR-001
  canal text not null, -- ADR-001
  data date not null, -- ADR-001
  observacao text not null, -- ADR-001
  constraint kit_recebimentos_pkey primary key (recebimento_id), -- ADR-001
  constraint kit_recebimentos_ordem_id_fkey foreign key (ordem_id) references public.kit_ordens (ordem_id), -- ADR-001
  constraint kit_recebimentos_fornecedor_id_fkey foreign key (fornecedor_id) references public.kit_fornecedores (fornecedor_id), -- ADR-001
  constraint kit_recebimentos_check1 check (canal in ('doca_cd', 'app_loja')) -- ADR-001
);
alter table public.kit_recebimentos enable row level security; -- ADR-001

-- WMS e app de loja: recebimentos.json (#52)
create table public.kit_recebimento_itens ( -- ADR-001
  recebimento_id text not null, -- ADR-001
  codigo_fornecedor text not null, -- ADR-001
  descricao text not null, -- ADR-001
  quantidade integer not null, -- ADR-001
  unidade text not null, -- ADR-001
  constraint kit_recebimento_itens_pkey primary key (recebimento_id, codigo_fornecedor), -- ADR-001
  constraint kit_recebimento_itens_recebimento_id_fkey foreign key (recebimento_id) references public.kit_recebimentos (recebimento_id) -- ADR-001
);
alter table public.kit_recebimento_itens enable row level security; -- ADR-001

-- regra de negócio (régua): regua.json (#52)
create table public.kit_regua ( -- ADR-001
  id smallint not null, -- ADR-001
  tolerancia_valor numeric not null, -- ADR-001
  tolerancia_percentual numeric not null, -- ADR-001
  teto_regra_tolerancia numeric not null, -- ADR-001
  teto_analista numeric not null, -- ADR-001
  teto_coordenacao numeric not null, -- ADR-001
  niveis text[] not null, -- ADR-001
  texto text[] not null, -- ADR-001
  constraint kit_regua_pkey primary key (id), -- ADR-001
  constraint kit_regua_check1 check (id = 1) -- ADR-001
);
alter table public.kit_regua enable row level security; -- ADR-001

-- regra de negócio (exceções): excecoes.json (#52)
create table public.kit_excecoes ( -- ADR-001
  codigo text not null, -- ADR-001
  descricao text not null, -- ADR-001
  constraint kit_excecoes_pkey primary key (codigo) -- ADR-001
);
alter table public.kit_excecoes enable row level security; -- ADR-001
