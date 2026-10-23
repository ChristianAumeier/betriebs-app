-- 005: PV-Wechselrichter von Growatt (Stockhalle, später Wohnhaus 2)
-- Supabase holt die Werte selbst alle 5 Minuten bei Growatt ab, ohne Home Assistant und NAS.
-- Ablauf: pg_cron schickt zur Minute 0, 5, 10 … eine Anfrage über pg_net (asynchron),
-- eine Minute später wird die Antwort ausgewertet und in die Tabellen geschrieben.
-- Der Growatt-Token liegt im Supabase Vault (Name 'growatt_token'), nie im Repository.
-- Vorher nötig: 003 (http, pg_cron) und 004 (pg_net). Als Migration angewendet (2026-10-23).

-- Stammdaten: welcher Wechselrichter ist welche Anlage
create table if not exists public.pv_wechselrichter (
  sn text primary key,                 -- Seriennummer vom Typenschild
  anlage text not null,                -- Growatt-Anlage: 'Stockhalle' oder 'Eigenverbrauch'
  nr int,                              -- Anlage 1–4 laut Zählerschrank
  name text not null,                  -- Name wie auf dem Zählerschild
  zaehler text,                        -- Zählernummer
  kw numeric,                          -- Nennleistung Wechselrichter
  sortierung int not null default 0
);

-- Letzter Stand je Wechselrichter
create table if not exists public.pv_live (
  sn text primary key references public.pv_wechselrichter(sn),
  gemeldet_am timestamptz,             -- Zeitpunkt der Messung laut Growatt
  leistung_w numeric,
  heute_kwh numeric,                   -- gilt nur, wenn gemeldet_am von heute ist
  gesamt_kwh numeric,
  temperatur numeric,
  status int,
  stick text,
  abgerufen_am timestamptz not null default now(),
  roh jsonb                            -- vollständige Growatt-Antwort für spätere Auswertungen
);

-- Tageswerte (für Auswertungen und Abrechnungsprüfung)
create table if not exists public.pv_tag (
  sn text not null references public.pv_wechselrichter(sn),
  tag date not null,
  kwh numeric not null,
  gesamt_kwh numeric,
  aktualisiert_am timestamptz not null default now(),
  primary key (sn, tag)
);

-- Zustand des Abrufs (damit die App Fehler mit Originaltext zeigen kann)
create table if not exists public.pv_abruf (
  id int primary key default 1 check (id = 1),
  letzter_versuch timestamptz,
  letzter_erfolg timestamptz,
  fehler text
);
insert into public.pv_abruf (id) values (1) on conflict (id) do nothing;

-- Lesen nur nach Anmeldung mit Code, Schreiben nur durch die Funktionen unten
do $$
declare t text;
begin
  foreach t in array array['pv_wechselrichter', 'pv_live', 'pv_tag', 'pv_abruf'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists "Lesen nur nach Anmeldung mit Code" on public.%I', t);
    execute format('create policy "Lesen nur nach Anmeldung mit Code" on public.%I for select to authenticated using ((auth.jwt() ->> ''aal'') = ''aal2'')', t);
  end loop;
end $$;

insert into public.pv_wechselrichter (sn, anlage, nr, name, zaehler, kw, sortierung) values
  ('UJH2BFH01J', 'Stockhalle', 1, 'Carolin', '1 ESY11 6300 0411', 30, 1),
  ('UJHBCGF02Q', 'Stockhalle', 2, 'Carolin und Christian', '1 ESY11 6300 0412', 30, 2),
  ('UJHBCGF02E', 'Stockhalle', 3, 'Renate', '1 ESY11 6300 0413', 30, 3),
  ('UJHBCGF03J', 'Stockhalle', 4, 'Renate und Josef', '1 ESY11 6300 0414', 30, 4),
  ('EWFGCGK074', 'Eigenverbrauch', null, 'Wohnhaus 2', null, 20, 10)
on conflict (sn) do update set anlage = excluded.anlage, nr = excluded.nr, name = excluded.name,
  zaehler = excluded.zaehler, kw = excluded.kw, sortierung = excluded.sortierung;

-- Merkt sich die zuletzt gesendete Anfrage
create table if not exists intern.growatt_anfrage (
  id int primary key default 1 check (id = 1),
  anfrage_id bigint,
  gesendet_am timestamptz,
  verarbeitet boolean not null default true
);
revoke all on intern.growatt_anfrage from public, anon, authenticated;
insert into intern.growatt_anfrage (id) values (1) on conflict (id) do nothing;

-- Anfrage an Growatt schicken (alle Wechselrichter in einer Anfrage, Growatt erlaubt nur wenige Abrufe)
create or replace function intern.growatt_senden()
returns void language plpgsql security definer set search_path = '' as $$
declare
  geraete text;
  rid bigint;
begin
  select string_agg(sn, ',' order by sortierung) into geraete from public.pv_wechselrichter;
  rid := net.http_post(
    url := 'https://openapi.growatt.com/v4/new-api/queryLastData?deviceType=max&deviceSn=' || geraete,
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'token', (select decrypted_secret from vault.decrypted_secrets where name = 'growatt_token'),
      'Content-Type', 'application/json'),
    timeout_milliseconds := 30000);
  update intern.growatt_anfrage set anfrage_id = rid, gesendet_am = now(), verarbeitet = false where id = 1;
  update public.pv_abruf set letzter_versuch = now() where id = 1;
end $$;

-- Antwort auswerten und speichern
create or replace function intern.growatt_verarbeiten()
returns void language plpgsql security definer set search_path = '' as $$
declare
  a intern.growatt_anfrage%rowtype;
  r record;
  j jsonb;
  x jsonb;
  zeit timestamptz;
  heute date := (now() at time zone 'Europe/Berlin')::date;
begin
  select * into a from intern.growatt_anfrage where id = 1;
  if a.verarbeitet or a.anfrage_id is null then return; end if;

  select status_code, content, error_msg, timed_out into r from net._http_response where id = a.anfrage_id;
  if not found then return; end if;   -- Antwort noch nicht da, nächster Lauf versucht es wieder
  update intern.growatt_anfrage set verarbeitet = true where id = 1;

  if r.status_code is distinct from 200 then
    update public.pv_abruf set fehler = coalesce(r.error_msg, 'HTTP ' || r.status_code) where id = 1;
    return;
  end if;
  begin
    j := r.content::jsonb;
  exception when others then
    update public.pv_abruf set fehler = 'Antwort kein JSON: ' || left(r.content, 200) where id = 1;
    return;
  end;
  if (j ->> 'code') is distinct from '0' then
    update public.pv_abruf set fehler = 'Growatt: ' || coalesce(j ->> 'message', j::text) where id = 1;
    return;
  end if;

  for x in select * from jsonb_array_elements(coalesce(j -> 'data' -> 'max', '[]'::jsonb)) loop
    if not exists (select 1 from public.pv_wechselrichter w where w.sn = x ->> 'serialNum') then continue; end if;
    zeit := ((x ->> 'time')::timestamp at time zone 'Europe/Berlin');
    insert into public.pv_live (sn, gemeldet_am, leistung_w, heute_kwh, gesamt_kwh, temperatur, status, stick, abgerufen_am, roh)
    values (x ->> 'serialNum', zeit, (x ->> 'pac')::numeric, (x ->> 'eacToday')::numeric, (x ->> 'eacTotal')::numeric,
            (x ->> 'temperature')::numeric, (x ->> 'status')::int, x ->> 'dataLogSn', now(), x)
    on conflict (sn) do update set gemeldet_am = excluded.gemeldet_am, leistung_w = excluded.leistung_w,
      heute_kwh = excluded.heute_kwh, gesamt_kwh = excluded.gesamt_kwh, temperatur = excluded.temperatur,
      status = excluded.status, stick = excluded.stick, abgerufen_am = excluded.abgerufen_am, roh = excluded.roh;
    -- Tageswert nur, wenn die Messung von heute ist
    if (zeit at time zone 'Europe/Berlin')::date = heute then
      insert into public.pv_tag (sn, tag, kwh, gesamt_kwh, aktualisiert_am)
      values (x ->> 'serialNum', heute, (x ->> 'eacToday')::numeric, (x ->> 'eacTotal')::numeric, now())
      on conflict (sn, tag) do update set kwh = excluded.kwh, gesamt_kwh = excluded.gesamt_kwh, aktualisiert_am = now();
    end if;
  end loop;
  update public.pv_abruf set letzter_erfolg = now(), fehler = null where id = 1;
end $$;

revoke all on function intern.growatt_senden() from public, anon, authenticated;
revoke all on function intern.growatt_verarbeiten() from public, anon, authenticated;

-- Zeitplan: senden zur Minute 0, 5, 10 …; auswerten jeweils 1 Minute danach
select cron.unschedule(jobname) from cron.job where jobname in ('growatt_senden', 'growatt_verarbeiten');
select cron.schedule('growatt_senden', '*/5 * * * *', 'select intern.growatt_senden()');
select cron.schedule('growatt_verarbeiten', '1-59/5 * * * *', 'select intern.growatt_verarbeiten()');
