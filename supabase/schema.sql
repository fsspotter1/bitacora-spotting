-- Bitácora Spotting · esquema inicial (beta)
-- Pegar entero en Supabase → SQL Editor → Run. Se puede ejecutar más de una vez.

create table if not exists public.entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  fecha       date,
  matricula   text default '',
  tipo        text default '',
  operador    text default '',
  aeropuerto  text default '',
  carpeta     text default '',
  archivo     text default '',
  archivo2    text default '',
  nota        text default '',
  pendiente   boolean not null default true,
  thumb_path  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists entries_user_fecha on public.entries (user_id, fecha desc);
create index if not exists entries_user_matricula on public.entries (user_id, matricula);

alter table public.entries enable row level security;

drop policy if exists "propias: ver" on public.entries;
drop policy if exists "propias: crear" on public.entries;
drop policy if exists "propias: editar" on public.entries;
drop policy if exists "propias: borrar" on public.entries;
create policy "propias: ver"    on public.entries for select using (auth.uid() = user_id);
create policy "propias: crear"  on public.entries for insert with check (auth.uid() = user_id);
create policy "propias: editar" on public.entries for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "propias: borrar" on public.entries for delete using (auth.uid() = user_id);

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists entries_touch on public.entries;
create trigger entries_touch before update on public.entries for each row execute function public.touch_updated_at();

-- Miniaturas (≈30 KB cada una), carpeta privada por usuario: thumbs/<user_id>/<archivo>.jpg
insert into storage.buckets (id, name, public) values ('thumbs', 'thumbs', false)
on conflict (id) do nothing;

drop policy if exists "thumbs: ver propias" on storage.objects;
drop policy if exists "thumbs: subir propias" on storage.objects;
drop policy if exists "thumbs: cambiar propias" on storage.objects;
drop policy if exists "thumbs: borrar propias" on storage.objects;
create policy "thumbs: ver propias" on storage.objects for select
  using (bucket_id = 'thumbs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "thumbs: subir propias" on storage.objects for insert
  with check (bucket_id = 'thumbs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "thumbs: cambiar propias" on storage.objects for update
  using (bucket_id = 'thumbs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "thumbs: borrar propias" on storage.objects for delete
  using (bucket_id = 'thumbs' and (storage.foldername(name))[1] = auth.uid()::text);


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
