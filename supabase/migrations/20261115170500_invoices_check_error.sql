-- #56 A nota que quebra na conferência fica a conferir, com o motivo; a rodada segue para as outras.
-- #56 Conferida numa rodada seguinte, o motivo volta a nulo.
alter table public.invoices add column check_error text;
