-- 001: Briefkasten „Energie Zuhause“
-- Der Home Assistant wirft alle 30 Sekunden die aktuellen Werte ein,
-- die App liest sie (nur nach Anmeldung mit Code).
-- Als Migration angewendet (Supabase-Connector, 2026-10-22).

-- Interner Bereich, der nicht über das Internet erreichbar ist
create schema if not exists intern;
revoke all on schema intern from public, anon, authenticated;

create table if not exists intern.schluessel (
  name text primary key,
  hash text not null,
  angelegt_am timestamptz not null default now()
);
revoke all on intern.schluessel from public, anon, authenticated;

-- Eine einzige Zeile mit den aktuellen Werten
create table if not exists public.energie_zuhause (
  id int primary key default 1 check (id = 1),
  werte jsonb not null default '{}'::jsonb,
  tag date,
  tagesstart jsonb not null default '{}'::jsonb,
  aktualisiert_am timestamptz
);
insert into public.energie_zuhause (id) values (1) on conflict (id) do nothing;

alter table public.energie_zuhause enable row level security;
revoke all on public.energie_zuhause from public, anon, authenticated;
grant select on public.energie_zuhause to authenticated;

drop policy if exists "Lesen nur nach Anmeldung mit Code" on public.energie_zuhause;
create policy "Lesen nur nach Anmeldung mit Code" on public.energie_zuhause
  for select to authenticated
  using ((auth.jwt() ->> 'aal') = 'aal2');

-- Einwurf durch den Home Assistant.
-- Der Schlüssel kommt im Kopf der Anfrage (x-ha-schluessel) und wird nur als Prüfsumme gespeichert.
-- Zum Tageswechsel (deutsche Zeit) merkt sich die Funktion die Zählerstände als „Tagesstart“,
-- daraus rechnet die App die Werte für „Heute“.
create or replace function public.ha_melden(p_werte jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  k text := current_setting('request.headers', true)::json ->> 'x-ha-schluessel';
  heute date := (now() at time zone 'Europe/Berlin')::date;
  zeile public.energie_zuhause%rowtype;
  neuer_tag boolean;
  start jsonb;
begin
  if k is null or not exists (
    select 1 from intern.schluessel s
    where s.name = 'homeassistant'
      and s.hash = encode(sha256(convert_to(k, 'UTF8')), 'hex')
  ) then
    raise exception 'Schlüssel ungültig' using errcode = '42501';
  end if;

  select * into zeile from public.energie_zuhause where id = 1 for update;
  neuer_tag := zeile.tag is distinct from heute;
  start := case when neuer_tag then '{}'::jsonb else zeile.tagesstart end;

  -- Jeden Zählerstand nur einmal pro Tag merken (falls er beim Tageswechsel fehlte: beim ersten gültigen Wert)
  start := start
    || case when start ? 'erzeugung_kwh' or nullif(p_werte -> 'erzeugung_kwh_gesamt', 'null'::jsonb) is null then '{}'::jsonb
            else jsonb_build_object('erzeugung_kwh', p_werte -> 'erzeugung_kwh_gesamt') end
    || case when start ? 'bezug_kwh' or nullif(p_werte -> 'bezug_kwh_gesamt', 'null'::jsonb) is null then '{}'::jsonb
            else jsonb_build_object('bezug_kwh', p_werte -> 'bezug_kwh_gesamt') end
    || case when start ? 'einspeisung_kwh' or nullif(p_werte -> 'einspeisung_kwh_gesamt', 'null'::jsonb) is null then '{}'::jsonb
            else jsonb_build_object('einspeisung_kwh', p_werte -> 'einspeisung_kwh_gesamt') end;

  update public.energie_zuhause
     set werte = p_werte,
         tag = heute,
         tagesstart = start,
         aktualisiert_am = now()
   where id = 1;
end;
$$;

revoke all on function public.ha_melden(jsonb) from public, anon, authenticated;
grant execute on function public.ha_melden(jsonb) to anon;

-- Der Schlüssel selbst entsteht nicht hier. Claude erzeugt ihn auf dem PC, schreibt ihn
-- direkt in die secrets.yaml des Home Assistant und trägt nur die Prüfsumme (SHA-256) ein:
--   insert into intern.schluessel (name, hash) values ('homeassistant', '<prüfsumme>')
--   on conflict (name) do update set hash = excluded.hash, angelegt_am = now();
-- Der Schlüssel erscheint nie im Chat, in einer Ausgabe oder im Repository.
