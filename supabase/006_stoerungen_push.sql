-- 006: Störungsmeldungen mit zwei Kategorien und Push-Mitteilungen aufs Handy
--   wichtig = Push-Mitteilung (einmal beim Auftreten, einmal wenn behoben) und Meldung in der App
--   hinweis = nur Meldung in der App (Leiste auf der Startseite)
-- Die Prüfung läuft alle 5 Minuten in der Datenbank (pg_cron), auch wenn die App zu ist.
-- Versand über die Edge Function `push-senden` (supabase/functions/push-senden).
-- Schlüssel im Vault: vapid_privat, vapid_oeffentlich (Web-Push), push_ausloeser (Datenbank → Funktion).
-- Als Migration angewendet (2026-10-23).

-- Geräte, die Mitteilungen bekommen (ein Eintrag je Handy/Browser)
create table if not exists public.push_abos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  geraet text,
  angelegt_am timestamptz not null default now(),
  zuletzt_ok timestamptz,
  fehler text
);
alter table public.push_abos enable row level security;
revoke all on public.push_abos from public, anon, authenticated;
grant select on public.push_abos to authenticated;
-- Die Edge Function arbeitet als service_role; neue Tabellen bekommen hier keine Rechte automatisch
-- (als eigene Migration 007 nachgetragen).
grant select, update, delete on public.push_abos to service_role;
drop policy if exists "Eigene Geräte lesen" on public.push_abos;
create policy "Eigene Geräte lesen" on public.push_abos for select to authenticated
  using ((auth.jwt() ->> 'aal') = 'aal2' and user_id = auth.uid());

-- Störungen
create table if not exists public.stoerungen (
  id bigint generated always as identity primary key,
  schluessel text not null,              -- z. B. 'ph_stumm:UJH2BFH01J'
  bereich text not null,                 -- z. B. 'PV Stockhalle'
  kategorie text not null check (kategorie in ('wichtig', 'hinweis')),
  text text not null,
  seit timestamptz not null default now(),
  behoben_am timestamptz,
  push_gemeldet boolean not null default false,
  push_behoben boolean not null default false
);
create unique index if not exists stoerungen_offen on public.stoerungen (schluessel) where behoben_am is null;
alter table public.stoerungen enable row level security;
revoke all on public.stoerungen from public, anon, authenticated;
grant select on public.stoerungen to authenticated;
drop policy if exists "Lesen nur nach Anmeldung mit Code" on public.stoerungen;
create policy "Lesen nur nach Anmeldung mit Code" on public.stoerungen for select to authenticated
  using ((auth.jwt() ->> 'aal') = 'aal2');

-- Gerät anmelden / abmelden (nur mit Anmeldung + Code)
create or replace function public.push_abo_speichern(p_endpoint text, p_p256dh text, p_auth text, p_geraet text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or (auth.jwt() ->> 'aal') is distinct from 'aal2' then
    raise exception 'Nur nach Anmeldung mit Code' using errcode = '42501';
  end if;
  insert into public.push_abos (user_id, endpoint, p256dh, auth, geraet)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, p_geraet)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh,
    auth = excluded.auth, geraet = excluded.geraet, fehler = null;
end $$;

create or replace function public.push_abo_loeschen(p_endpoint text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet' using errcode = '42501'; end if;
  delete from public.push_abos where endpoint = p_endpoint and user_id = auth.uid();
end $$;

-- Nachrichten an die Edge Function übergeben (asynchron über pg_net)
create or replace function intern.push_ausloesen(p_nachrichten jsonb, p_nur_user uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if jsonb_array_length(p_nachrichten) = 0 then return; end if;
  perform net.http_post(
    url := 'https://trwazyqryqdjbfggaufd.supabase.co/functions/v1/push-senden',
    body := jsonb_build_object('nachrichten', p_nachrichten, 'nur_user', p_nur_user),
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-push-ausloeser', (select decrypted_secret from vault.decrypted_secrets where name = 'push_ausloeser')),
    timeout_milliseconds := 30000);
end $$;

-- Testmitteilung an die eigenen Geräte (Knopf in der App)
create or replace function public.push_test()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or (auth.jwt() ->> 'aal') is distinct from 'aal2' then
    raise exception 'Nur nach Anmeldung mit Code' using errcode = '42501';
  end if;
  perform intern.push_ausloesen(jsonb_build_array(jsonb_build_object(
    'titel', 'Betrieb Aumeier', 'text', 'Testmitteilung: Die Mitteilungen funktionieren.', 'ziel', '#')), auth.uid());
end $$;

-- Nur für die Edge Function (Rolle service_role): Schlüssel holen
create or replace function public.push_geheimnisse()
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'privat', (select decrypted_secret from vault.decrypted_secrets where name = 'vapid_privat'),
    'oeffentlich', (select decrypted_secret from vault.decrypted_secrets where name = 'vapid_oeffentlich'),
    'ausloeser', (select decrypted_secret from vault.decrypted_secrets where name = 'push_ausloeser'));
$$;

revoke all on function public.push_abo_speichern(text, text, text, text) from public, anon, authenticated;
revoke all on function public.push_abo_loeschen(text) from public, anon, authenticated;
revoke all on function public.push_test() from public, anon, authenticated;
revoke all on function public.push_geheimnisse() from public, anon, authenticated;
revoke all on function intern.push_ausloesen(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.push_abo_speichern(text, text, text, text) to authenticated;
grant execute on function public.push_abo_loeschen(text) to authenticated;
grant execute on function public.push_test() to authenticated;
grant execute on function public.push_geheimnisse() to service_role;

-- Eine Störung setzen (öffnen, Kategorie hochstufen, Text auffrischen)
create or replace function intern.stoerung_setzen(p_schluessel text, p_bereich text, p_kategorie text, p_text text, p_seit timestamptz default now())
returns void language plpgsql security definer set search_path = '' as $$
declare s public.stoerungen%rowtype;
begin
  select * into s from public.stoerungen where schluessel = p_schluessel and behoben_am is null;
  if not found then
    insert into public.stoerungen (schluessel, bereich, kategorie, text, seit)
    values (p_schluessel, p_bereich, p_kategorie, p_text, p_seit);
  else
    update public.stoerungen set text = p_text,
      kategorie = case when p_kategorie = 'wichtig' then 'wichtig' else kategorie end
    where id = s.id;
  end if;
end $$;

create or replace function intern.stoerung_beheben(p_schluessel text)
returns void language sql security definer set search_path = '' as $$
  update public.stoerungen set behoben_am = now() where schluessel = p_schluessel and behoben_am is null;
$$;

-- Die eigentliche Prüfung (alle 5 Minuten)
-- Regeln (mit Christian vereinbart 23.10.2026):
--   Stockhalle: Anlage meldet tagsüber > 60 min nicht → wichtig
--   Stockhalle: Anlage liefert < 60 % der anderen → hinweis, nach 60 min → wichtig
--   Growatt-Abruf: > 15 min kein Erfolg → hinweis, > 2 h → wichtig
--   Home Assistant (Energie Zuhause): > 5 min keine Meldung → hinweis, > 30 min → wichtig
--   Wohnhaus 2 (Growatt): meldet seit > 1 Tag nicht → hinweis
--   „Tagsüber“ = mindestens eine Stockhallen-Anlage hat in den letzten 20 min ≥ 1 kW gemeldet.
--   Nachts werden Stockhallen-Störungen weder geöffnet noch geschlossen (außer: Anlage meldet wieder).
create or replace function intern.stoerungen_pruefen()
returns void language plpgsql security definer set search_path = '' as $$
declare
  sonne boolean;
  a record;
  mittel numeric;
  abruf timestamptz;
  ha timestamptz;
  s public.stoerungen%rowtype;
  nachrichten jsonb := '[]'::jsonb;
begin
  select exists (select 1 from public.pv_live l join public.pv_wechselrichter w using (sn)
                 where w.anlage = 'Stockhalle' and l.gemeldet_am > now() - interval '20 minutes' and l.leistung_w >= 1000)
    into sonne;

  -- Stockhalle je Anlage
  for a in select w.sn, w.nr, w.name, l.gemeldet_am, l.leistung_w
           from public.pv_wechselrichter w left join public.pv_live l using (sn)
           where w.anlage = 'Stockhalle' loop
    -- meldet nicht
    if a.gemeldet_am is not null and a.gemeldet_am > now() - interval '20 minutes' then
      perform intern.stoerung_beheben('ph_stumm:' || a.sn);
    elsif sonne and (a.gemeldet_am is null or a.gemeldet_am < now() - interval '60 minutes') then
      perform intern.stoerung_setzen('ph_stumm:' || a.sn, 'PV Stockhalle', 'wichtig',
        'Anlage ' || a.nr || ' „' || a.name || '“ meldet seit ' ||
        coalesce(to_char(a.gemeldet_am at time zone 'Europe/Berlin', 'DD.MM. HH24:MI'), 'unbekannt') || ' Uhr nicht.',
        coalesce(a.gemeldet_am, now()));
    end if;
    -- liefert zu wenig
    if sonne then
      select avg(l.leistung_w) into mittel from public.pv_live l join public.pv_wechselrichter w using (sn)
      where w.anlage = 'Stockhalle' and w.sn <> a.sn and l.gemeldet_am > now() - interval '20 minutes';
      if a.gemeldet_am > now() - interval '20 minutes' and mittel >= 1000 and a.leistung_w < mittel * 0.6 then
        perform intern.stoerung_setzen('ph_schwach:' || a.sn, 'PV Stockhalle',
          case when exists (select 1 from public.stoerungen x where x.schluessel = 'ph_schwach:' || a.sn
                            and x.behoben_am is null and x.seit < now() - interval '60 minutes')
               then 'wichtig' else 'hinweis' end,
          'Anlage ' || a.nr || ' „' || a.name || '“ liefert nur ' || round(a.leistung_w / mittel * 100) || ' % der anderen.');
      elsif a.gemeldet_am > now() - interval '20 minutes' then
        perform intern.stoerung_beheben('ph_schwach:' || a.sn);
      end if;
    end if;
  end loop;

  -- Wohnhaus 2 bei Growatt
  if exists (select 1 from public.pv_live where sn = 'EWFGCGK074' and gemeldet_am < now() - interval '1 day') then
    perform intern.stoerung_setzen('pv_stumm:EWFGCGK074', 'PV Wohnhaus 2', 'hinweis',
      'Wohnhaus 2 meldet bei Growatt seit ' ||
      (select to_char(gemeldet_am at time zone 'Europe/Berlin', 'DD.MM.YYYY') from public.pv_live where sn = 'EWFGCGK074') ||
      ' nicht (Erdkabel, Switch-Tausch geplant).',
      (select gemeldet_am from public.pv_live where sn = 'EWFGCGK074'));
  elsif exists (select 1 from public.pv_live where sn = 'EWFGCGK074' and gemeldet_am > now() - interval '1 hour') then
    perform intern.stoerung_beheben('pv_stumm:EWFGCGK074');
  end if;

  -- Growatt-Abruf
  select letzter_erfolg into abruf from public.pv_abruf where id = 1;
  if abruf is null or abruf < now() - interval '15 minutes' then
    perform intern.stoerung_setzen('growatt_abruf', 'Growatt',
      case when abruf is null or abruf < now() - interval '2 hours' then 'wichtig' else 'hinweis' end,
      'Der Abruf bei Growatt klappt seit ' || coalesce(to_char(abruf at time zone 'Europe/Berlin', 'DD.MM. HH24:MI') || ' Uhr', 'Beginn') || ' nicht' ||
      coalesce(': ' || (select fehler from public.pv_abruf where id = 1), '') || '.', coalesce(abruf, now()));
  else
    perform intern.stoerung_beheben('growatt_abruf');
  end if;

  -- Home Assistant
  select aktualisiert_am into ha from public.energie_zuhause where id = 1;
  if ha is not null and ha < now() - interval '5 minutes' then
    perform intern.stoerung_setzen('ha_stumm', 'Energie Zuhause',
      case when ha < now() - interval '30 minutes' then 'wichtig' else 'hinweis' end,
      'Der Home Assistant meldet sich seit ' || to_char(ha at time zone 'Europe/Berlin', 'DD.MM. HH24:MI') ||
      ' Uhr nicht (NAS oder Home Assistant hängt, oder Internet zu Hause weg).', ha);
  elsif ha is not null then
    perform intern.stoerung_beheben('ha_stumm');
  end if;

  -- Push: neue wichtige Störungen und behobene wichtige Störungen
  for s in select * from public.stoerungen where kategorie = 'wichtig' and not push_gemeldet and behoben_am is null loop
    nachrichten := nachrichten || jsonb_build_object('titel', 'Störung: ' || s.bereich, 'text', s.text, 'ziel', '#');
    update public.stoerungen set push_gemeldet = true where id = s.id;
  end loop;
  for s in select * from public.stoerungen where kategorie = 'wichtig' and push_gemeldet and not push_behoben and behoben_am is not null loop
    nachrichten := nachrichten || jsonb_build_object('titel', 'Behoben: ' || s.bereich, 'text', 'Wieder in Ordnung. Vorher: ' || s.text, 'ziel', '#');
    update public.stoerungen set push_behoben = true where id = s.id;
  end loop;
  perform intern.push_ausloesen(nachrichten);
end $$;

revoke all on function intern.stoerung_setzen(text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function intern.stoerung_beheben(text) from public, anon, authenticated;
revoke all on function intern.stoerungen_pruefen() from public, anon, authenticated;

-- Prüfung 2 Minuten nach jedem Growatt-Abruf
select cron.unschedule(jobname) from cron.job where jobname = 'stoerungen_pruefen';
select cron.schedule('stoerungen_pruefen', '2-59/5 * * * *', 'select intern.stoerungen_pruefen()');
