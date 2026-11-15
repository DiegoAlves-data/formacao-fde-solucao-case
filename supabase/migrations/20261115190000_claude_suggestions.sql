-- Sugestões do Claude, gravadas pelo executor do GitHub Actions (jobs/claude, #66).
-- #66 O Worker não chama o Claude: só lê esta tabela, e a regra determinística confirma a sugestão.
-- #66 Sem sugestão, a regra decide sozinha (fail-closed).
-- #66 RLS ligado e nenhuma política: só a chave secreta lê e grava.

create table public.claude_suggestions (
  id bigint generated always as identity primary key,
  -- #66 Nome da tarefa (ex.: description-match), um arquivo em jobs/claude/src/tasks/.
  task text not null,
  -- #66 Chave estável da entrada; o Worker calcula a mesma para achar a sugestão.
  input_key text not null,
  input jsonb not null,
  -- #66 Nulo quando a chamada falhou.
  output jsonb,
  status text not null,
  model text not null,
  -- #66 Falha curta: classe e, só para erro do próprio executor, o começo da mensagem; nunca segredo.
  error text,
  -- #66 Tentativas com erro; o laço para em 3 e espera 5 min * 2^attempts desde updated_at (#66).
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  -- #66 Última escrita da linha; o executor a grava em cada tentativa, base da espera entre tentativas.
  updated_at timestamptz not null default now(),
  constraint claude_suggestions_status_check check (status in ('ok', 'error')),
  constraint claude_suggestions_task_input_key_key unique (task, input_key)
);
alter table public.claude_suggestions enable row level security;
