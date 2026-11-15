-- Base do kit: tabelas que espelham os JSON de data/kit/ (ver data/kit/contrato.json).
-- RLS ligado em toda tabela e nenhuma política: só o Worker lê, com a chave secreta.

-- ERP (cadastro): fornecedores.json
create table public.kit_fornecedores (
  fornecedor_id text not null,
  razao_social text not null,
  cnpj text not null,
  bloqueado boolean not null,
  motivo_bloqueio text not null,
  constraint kit_fornecedores_pkey primary key (fornecedor_id)
);
alter table public.kit_fornecedores enable row level security;

-- ERP (cadastro): produtos.json
create table public.kit_produtos (
  sku text not null,
  descricao text not null,
  fornecedor_id text not null,
  codigo_fornecedor text not null,
  unidade_base text not null,
  fator_caixa integer not null,
  preco_referencia_un numeric(12,2) not null,
  constraint kit_produtos_pkey primary key (sku),
  constraint kit_produtos_fornecedor_id_fkey foreign key (fornecedor_id) references public.kit_fornecedores (fornecedor_id)
);
alter table public.kit_produtos enable row level security;

-- ERP (compras): ordens.json
create table public.kit_ordens (
  ordem_id text not null,
  fornecedor_id text not null,
  destino text not null,
  data_emissao date not null,
  status text not null,
  motivo_status text not null,
  valor_total numeric(14,2) not null,
  constraint kit_ordens_pkey primary key (ordem_id),
  constraint kit_ordens_fornecedor_id_fkey foreign key (fornecedor_id) references public.kit_fornecedores (fornecedor_id),
  constraint kit_ordens_check1 check (status in ('aberta', 'atendida', 'travada'))
);
alter table public.kit_ordens enable row level security;

-- ERP (compras): ordens.json
create table public.kit_ordem_itens (
  ordem_id text not null,
  codigo_fornecedor text not null,
  sku text,
  descricao text not null,
  quantidade integer not null,
  unidade text not null,
  preco_unitario numeric(12,2) not null,
  constraint kit_ordem_itens_pkey primary key (ordem_id, codigo_fornecedor),
  constraint kit_ordem_itens_ordem_id_fkey foreign key (ordem_id) references public.kit_ordens (ordem_id),
  constraint kit_ordem_itens_sku_fkey foreign key (sku) references public.kit_produtos (sku)
);
alter table public.kit_ordem_itens enable row level security;

-- SEFAZ: notas.json
create table public.kit_notas (
  chave text not null,
  nota_id text not null,
  numero integer not null,
  serie integer not null,
  fornecedor_id text not null,
  destino text not null,
  data_emissao date not null,
  pedido_referenciado text,
  canal_entrada text not null,
  valor_total numeric(14,2) not null,
  constraint kit_notas_pkey primary key (chave),
  constraint kit_notas_fornecedor_id_fkey foreign key (fornecedor_id) references public.kit_fornecedores (fornecedor_id),
  constraint kit_notas_pedido_referenciado_fkey foreign key (pedido_referenciado) references public.kit_ordens (ordem_id),
  constraint kit_notas_nota_id_key unique (nota_id)
);
alter table public.kit_notas enable row level security;

-- SEFAZ: notas.json
create table public.kit_nota_itens (
  chave text not null,
  codigo_fornecedor text not null,
  sku text,
  descricao text not null,
  quantidade integer not null,
  unidade text not null,
  preco_unitario numeric(12,2) not null,
  valor numeric(14,2) not null,
  constraint kit_nota_itens_pkey primary key (chave, codigo_fornecedor),
  constraint kit_nota_itens_chave_fkey foreign key (chave) references public.kit_notas (chave),
  constraint kit_nota_itens_sku_fkey foreign key (sku) references public.kit_produtos (sku)
);
alter table public.kit_nota_itens enable row level security;

-- ERP (contas a pagar): notas_lancadas.json
create table public.kit_notas_lancadas (
  chave text not null,
  nota_id text,
  numero integer not null,
  serie integer not null,
  fornecedor_id text not null,
  destino text not null,
  data_emissao date not null,
  pedido_referenciado text not null,
  canal_entrada text not null,
  valor_total numeric(14,2) not null,
  situacao text not null,
  constraint kit_notas_lancadas_pkey primary key (chave),
  constraint kit_notas_lancadas_fornecedor_id_fkey foreign key (fornecedor_id) references public.kit_fornecedores (fornecedor_id),
  constraint kit_notas_lancadas_pedido_referenciado_fkey foreign key (pedido_referenciado) references public.kit_ordens (ordem_id),
  constraint kit_notas_lancadas_check1 check (situacao in ('lançada', 'paga'))
);
alter table public.kit_notas_lancadas enable row level security;

-- ERP (contas a pagar): notas_lancadas.json
create table public.kit_nota_lancada_itens (
  chave text not null,
  codigo_fornecedor text not null,
  sku text,
  descricao text not null,
  quantidade integer not null,
  unidade text not null,
  preco_unitario numeric(12,2) not null,
  valor numeric(14,2) not null,
  constraint kit_nota_lancada_itens_pkey primary key (chave, codigo_fornecedor),
  constraint kit_nota_lancada_itens_chave_fkey foreign key (chave) references public.kit_notas_lancadas (chave),
  constraint kit_nota_lancada_itens_sku_fkey foreign key (sku) references public.kit_produtos (sku)
);
alter table public.kit_nota_lancada_itens enable row level security;

-- banco: pagamentos.json
create table public.kit_pagamentos (
  pagamento_id text not null,
  fornecedor_id text not null,
  destino text not null,
  data date not null,
  valor numeric(14,2) not null,
  forma text not null,
  origem text not null,
  nota_chave text,
  constraint kit_pagamentos_pkey primary key (pagamento_id),
  constraint kit_pagamentos_fornecedor_id_fkey foreign key (fornecedor_id) references public.kit_fornecedores (fornecedor_id)
);
alter table public.kit_pagamentos enable row level security;

-- WMS e app de loja: recebimentos.json
create table public.kit_recebimentos (
  recebimento_id text not null,
  nota_chave text,
  ordem_id text,
  fornecedor_id text not null,
  destino text not null,
  canal text not null,
  data date not null,
  observacao text not null,
  constraint kit_recebimentos_pkey primary key (recebimento_id),
  constraint kit_recebimentos_ordem_id_fkey foreign key (ordem_id) references public.kit_ordens (ordem_id),
  constraint kit_recebimentos_fornecedor_id_fkey foreign key (fornecedor_id) references public.kit_fornecedores (fornecedor_id),
  constraint kit_recebimentos_check1 check (canal in ('doca_cd', 'app_loja'))
);
alter table public.kit_recebimentos enable row level security;

-- WMS e app de loja: recebimentos.json
create table public.kit_recebimento_itens (
  recebimento_id text not null,
  codigo_fornecedor text not null,
  descricao text not null,
  quantidade integer not null,
  unidade text not null,
  constraint kit_recebimento_itens_pkey primary key (recebimento_id, codigo_fornecedor),
  constraint kit_recebimento_itens_recebimento_id_fkey foreign key (recebimento_id) references public.kit_recebimentos (recebimento_id)
);
alter table public.kit_recebimento_itens enable row level security;

-- regra de negócio (régua): regua.json
create table public.kit_regua (
  id smallint not null,
  tolerancia_valor numeric not null,
  tolerancia_percentual numeric not null,
  teto_regra_tolerancia numeric not null,
  teto_analista numeric not null,
  teto_coordenacao numeric not null,
  niveis text[] not null,
  texto text[] not null,
  constraint kit_regua_pkey primary key (id),
  constraint kit_regua_check1 check (id = 1)
);
alter table public.kit_regua enable row level security;

-- regra de negócio (exceções): excecoes.json
create table public.kit_excecoes (
  codigo text not null,
  descricao text not null,
  constraint kit_excecoes_pkey primary key (codigo)
);
alter table public.kit_excecoes enable row level security;
