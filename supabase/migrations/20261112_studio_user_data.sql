-- Estúdio ao Vivo: tudo o que cada usuário configurou (preferências/layout, projeto com cenas e widgets,
-- destinos de transmissão e conta do YouTube). Uma linha por usuário; só o dono lê e grava (RLS).
create table if not exists public.studio_user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  device text
);

alter table public.studio_user_data enable row level security;

drop policy if exists "dono le" on public.studio_user_data;
create policy "dono le" on public.studio_user_data for select to authenticated using (auth.uid() = user_id);
drop policy if exists "dono cria" on public.studio_user_data;
create policy "dono cria" on public.studio_user_data for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "dono altera" on public.studio_user_data;
create policy "dono altera" on public.studio_user_data for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Só usuários logados; o anônimo não enxerga a tabela.
revoke all on public.studio_user_data from anon;
grant select, insert, update on public.studio_user_data to authenticated;
