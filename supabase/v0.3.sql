-- Bitácora Spotting · v0.3 (cruce con ADS-B)
-- Pegar entero en Supabase → SQL Editor → Run. Se puede ejecutar más de una vez.
--
-- Cada día de un aeropuerto se procesa UNA vez (GitHub Actions, scripts/adsb_dia.py) y queda guardado para todos los
-- usuarios: tabla adsb_dias (estado) + almacén público «adsb» (el archivo comprimido con las trazas).
-- Los usuarios solo pueden leer y pedir días con pedir_adsb(); quien escribe es GitHub Actions con la clave
-- service_role (guardada como secreto en GitHub, nunca en la web).

create table if not exists public.adsb_dias (
  aeropuerto  text not null,
  fecha       date not null,               -- día UTC
  estado      text not null default 'pendiente'
              check (estado in ('pendiente', 'procesando', 'listo', 'sin_datos', 'error')),
  aviones     integer,
  bytes       integer,
  ruta        text,                        -- dentro del almacén «adsb»: LEVC/2026-11-10.json.gz
  mensaje     text default '',
  pedido_por  uuid references auth.users(id) on delete set null,
  creado      timestamptz not null default now(),
  actualizado timestamptz not null default now(),
  primary key (aeropuerto, fecha)
);
alter table public.adsb_dias enable row level security;
drop policy if exists "adsb: ver" on public.adsb_dias;
create policy "adsb: ver" on public.adsb_dias for select to authenticated using (true);

-- Pide un día: lo crea si no existe y dice si hay que lanzar el procesado ('lanzar') o en qué estado está.
-- También relanza los que se quedaron colgados o fallaron, y los recientes que adsb.lol aún no había publicado.
create or replace function public.pedir_adsb(p_aeropuerto text, p_fecha date) returns text
language plpgsql security definer set search_path = public as $$
declare r public.adsb_dias%rowtype;
begin
  if auth.uid() is null then raise exception 'sin sesión'; end if;
  if p_aeropuerto !~ '^[A-Z0-9]{4}$' then raise exception 'aeropuerto no válido'; end if;
  if p_fecha < date '2023-03-10' or p_fecha >= (now() at time zone 'utc')::date then return 'fuera_de_rango'; end if;
  select * into r from public.adsb_dias where aeropuerto = p_aeropuerto and fecha = p_fecha for update;
  if not found then
    insert into public.adsb_dias (aeropuerto, fecha, estado, pedido_por) values (p_aeropuerto, p_fecha, 'pendiente', auth.uid());
    return 'lanzar';
  end if;
  if (r.estado = 'error' and r.actualizado < now() - interval '2 minutes')
     or (r.estado = 'pendiente' and r.actualizado < now() - interval '20 minutes')
     or (r.estado = 'procesando' and r.actualizado < now() - interval '90 minutes')
     or (r.estado = 'sin_datos' and p_fecha > (now() at time zone 'utc')::date - 5 and r.actualizado < now() - interval '2 hours') then
    update public.adsb_dias set estado = 'pendiente', mensaje = '', pedido_por = auth.uid(), actualizado = now()
      where aeropuerto = p_aeropuerto and fecha = p_fecha;
    return 'lanzar';
  end if;
  return r.estado;
end $$;
revoke all on function public.pedir_adsb(text, date) from public, anon;
grant execute on function public.pedir_adsb(text, date) to authenticated;

-- Si el servidor no pudo lanzar el procesado, el día queda en error (se puede volver a pedir a los 2 minutos)
create or replace function public.soltar_adsb(p_aeropuerto text, p_fecha date, p_mensaje text) returns void
language sql security definer set search_path = public as $$
  update public.adsb_dias set estado = 'error', mensaje = left(coalesce(p_mensaje, ''), 200), actualizado = now()
  where aeropuerto = p_aeropuerto and fecha = p_fecha and estado = 'pendiente' and pedido_por = auth.uid();
$$;
revoke all on function public.soltar_adsb(text, date, text) from public, anon;
grant execute on function public.soltar_adsb(text, date, text) to authenticated;

-- Archivos de trazas: públicos para leer (son datos abiertos de adsb.lol); solo service_role escribe
insert into storage.buckets (id, name, public) values ('adsb', 'adsb', true)
on conflict (id) do update set public = true;
