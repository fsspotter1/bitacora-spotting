-- Bitácora Spotting · v0.2 (identificación con IA)
-- Pegar entero en Supabase → SQL Editor → Run. Se puede ejecutar más de una vez.

-- Lo que propuso la IA para cada registro (matrícula, tipo, confianza, motivo…)
alter table public.entries add column if not exists ia jsonb;

-- Uso de la IA: una fila por ráfaga identificada, para el límite diario por usuario
create table if not exists public.ai_uso (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index if not exists ai_uso_user_fecha on public.ai_uso (user_id, created_at desc);
alter table public.ai_uso enable row level security;
drop policy if exists "uso: ver propio" on public.ai_uso;
drop policy if exists "uso: anotar propio" on public.ai_uso;
create policy "uso: ver propio"    on public.ai_uso for select using (auth.uid() = user_id);
create policy "uso: anotar propio" on public.ai_uso for insert with check (auth.uid() = user_id);
-- (sin permiso para borrar: el usuario no puede reiniciar su contador)
