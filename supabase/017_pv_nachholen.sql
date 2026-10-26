-- 017: Tageswerte der Wechselrichter nach einem Ausfall nachholen
-- Ohne Internet am Wechselrichter bleibt der Tageswert in pv_tag stehen (z. B. 25.10.2026: Anlage 1–3 nur 0,1 kWh).
-- Der Datenlogger reicht die Werte nach, sobald er wieder online ist; Growatt hat sie dann in der Historie.
-- Ablauf: Jeder vergangene Tag wird einmal bei Growatt nachgefragt (queryHistoricalData, neuester Datensatz zuerst),
-- sobald der Wechselrichter sich nach dem Tag wieder gemeldet hat.
--   1. Growatt hat Daten und sie passen zum Zählerstand am nächsten Tag → quelle 'growatt'
--   2. sonst aus dem Gesamtzähler: Zählerstand Beginn nächster Tag minus Zählerstand Ende Vortag → quelle 'zaehler'
--      (fehlen mehrere Tage am Stück, wird die Differenz gleich verteilt und als geschätzt vermerkt)
-- pg_cron: Anfrage zur Minute 3, 13, 23 …, Auswertung eine Minute später (Growatt drosselt zu häufige Abrufe).

alter table public.pv_tag add column if not exists quelle text not null default 'live'
  check (quelle in ('live', 'growatt', 'zaehler'));
alter table public.pv_tag add column if not exists geprueft_am timestamptz;
alter table public.pv_tag add column if not exists hinweis text;

-- Versuche je Wechselrichter und Tag (damit ein Tag ohne Ergebnis nicht jede Runde wieder drankommt)
create table if not exists intern.pv_nachholen_versuch (
  sn text not null,
  tag date not null,
  versuche int not null default 0,
  letzter_versuch timestamptz,
  ergebnis text,
  primary key (sn, tag)
);
revoke all on intern.pv_nachholen_versuch from public, anon, authenticated;

create table if not exists intern.pv_nachholen_anfrage (
  id int primary key default 1 check (id = 1),
  anfrage_id bigint,
  sn text,
  tag date,
  gesendet_am timestamptz,
  verarbeitet boolean not null default true
);
revoke all on intern.pv_nachholen_anfrage from public, anon, authenticated;
insert into intern.pv_nachholen_anfrage (id) values (1) on conflict (id) do nothing;

-- Nächsten offenen Tag bei Growatt anfragen
create or replace function intern.pv_nachholen_senden()
returns void language plpgsql security definer set search_path = '' as $$
declare
  gestern date := (now() at time zone 'Europe/Berlin')::date - 1;
  k record;
begin
  select o.sn, o.tag into k
    from (
      select w.sn, d::date as tag
        from public.pv_wechselrichter w
        join (select sn, min(tag) as erster from public.pv_tag group by sn) e on e.sn = w.sn
        cross join lateral generate_series(e.erster, gestern, interval '1 day') d
    ) o
    join public.pv_live l on l.sn = o.sn
    left join public.pv_tag t on t.sn = o.sn and t.tag = o.tag
    left join intern.pv_nachholen_versuch v on v.sn = o.sn and v.tag = o.tag
   where t.geprueft_am is null
     -- erst, wenn sich der Wechselrichter nach dem Tag wieder gemeldet hat
     and l.gemeldet_am >= ((o.tag + 1)::timestamp at time zone 'Europe/Berlin')
     and coalesce(v.versuche, 0) < 48
     and (v.letzter_versuch is null or v.letzter_versuch < now() - interval '1 hour')
   order by o.tag, o.sn
   limit 1;
  if not found then return; end if;

  insert into intern.pv_nachholen_versuch (sn, tag, versuche, letzter_versuch) values (k.sn, k.tag, 1, now())
  on conflict (sn, tag) do update set versuche = intern.pv_nachholen_versuch.versuche + 1, letzter_versuch = now();

  update intern.pv_nachholen_anfrage
     set anfrage_id = net.http_post(
           url := 'https://openapi.growatt.com/v4/new-api/queryHistoricalData?deviceType=max&deviceSn=' || k.sn || '&date=' || k.tag,
           body := '{}'::jsonb,
           headers := jsonb_build_object(
             'token', (select decrypted_secret from vault.decrypted_secrets where name = 'growatt_token'),
             'Content-Type', 'application/json'),
           timeout_milliseconds := 30000),
         sn = k.sn, tag = k.tag, gesendet_am = now(), verarbeitet = false
   where id = 1;
end $$;

-- Antwort auswerten
create or replace function intern.pv_nachholen_verarbeiten()
returns void language plpgsql security definer set search_path = '' as $$
declare
  a intern.pv_nachholen_anfrage%rowtype;
  r record;
  j jsonb;
  g_kwh numeric;
  g_gesamt numeric;
  p public.pv_tag%rowtype;   -- letzter Tag davor
  n public.pv_tag%rowtype;   -- erster Tag danach
  n_start numeric;           -- Zählerstand zu Beginn von n
  luecke int;
  kwh numeric;
begin
  select * into a from intern.pv_nachholen_anfrage where id = 1;
  if a.verarbeitet or a.anfrage_id is null then return; end if;
  select status_code, content, error_msg into r from net._http_response where id = a.anfrage_id;
  if not found then return; end if;
  update intern.pv_nachholen_anfrage set verarbeitet = true where id = 1;

  if r.status_code is distinct from 200 then
    update intern.pv_nachholen_versuch set ergebnis = coalesce(r.error_msg, 'HTTP ' || r.status_code) where sn = a.sn and tag = a.tag;
    return;
  end if;
  begin
    j := r.content::jsonb;
  exception when others then
    update intern.pv_nachholen_versuch set ergebnis = 'Antwort kein JSON: ' || left(r.content, 200) where sn = a.sn and tag = a.tag;
    return;
  end;
  if (j ->> 'code') is distinct from '0' then
    -- z. B. 102 FREQUENTLY_ACCESS: nächste Runde in einer Stunde
    update intern.pv_nachholen_versuch set ergebnis = 'Growatt: ' || coalesce(j ->> 'message', j::text) where sn = a.sn and tag = a.tag;
    return;
  end if;

  select round(max((d ->> 'eacToday')::numeric), 1), round(max((d ->> 'eacTotal')::numeric), 1) into g_kwh, g_gesamt
    from jsonb_array_elements(coalesce(j -> 'data' -> 'datas', '[]'::jsonb)) d
   where (d ->> 'time')::date = a.tag;

  select * into p from public.pv_tag where sn = a.sn and tag < a.tag and gesamt_kwh is not null order by tag desc limit 1;
  select * into n from public.pv_tag where sn = a.sn and tag > a.tag and gesamt_kwh is not null order by tag limit 1;
  n_start := n.gesamt_kwh - n.kwh;

  -- 1. Growatt-Werte, wenn sie bis zum Zählerstand des nächsten Tages reichen (0,5 kWh Spielraum)
  if g_kwh is not null and (n.tag is distinct from a.tag + 1 or n_start - g_gesamt <= 0.5) then
    insert into public.pv_tag (sn, tag, kwh, gesamt_kwh, aktualisiert_am, quelle, geprueft_am, hinweis)
    values (a.sn, a.tag, g_kwh, g_gesamt, now(), 'growatt', now(), null)
    on conflict (sn, tag) do update set kwh = excluded.kwh, gesamt_kwh = excluded.gesamt_kwh, aktualisiert_am = now(),
      quelle = 'growatt', geprueft_am = now(), hinweis = null;
    update intern.pv_nachholen_versuch set ergebnis = 'growatt ' || g_kwh || ' kWh' where sn = a.sn and tag = a.tag;
    return;
  end if;

  -- 2. aus dem Gesamtzähler
  if p.tag is null or n.tag is null then
    update intern.pv_nachholen_versuch
       set ergebnis = case when g_kwh is null then 'Growatt ohne Daten' else 'Growatt unvollständig' end || ', Zählerstand davor/danach fehlt'
     where sn = a.sn and tag = a.tag;
    return;
  end if;
  luecke := n.tag - p.tag - 1;   -- Tage ohne sicheren Zählerstand zwischen p und n
  kwh := round(greatest(n_start - p.gesamt_kwh, 0) / luecke, 1);
  insert into public.pv_tag (sn, tag, kwh, gesamt_kwh, aktualisiert_am, quelle, geprueft_am, hinweis)
  values (a.sn, a.tag, kwh, p.gesamt_kwh + kwh, now(), 'zaehler', now(),
          case when luecke = 1 then 'aus dem Gesamtzähler berechnet'
               else 'geschätzt: Zählerdifferenz auf ' || luecke || ' Tage verteilt' end)
  on conflict (sn, tag) do update set kwh = excluded.kwh, gesamt_kwh = excluded.gesamt_kwh, aktualisiert_am = now(),
    quelle = 'zaehler', geprueft_am = now(), hinweis = excluded.hinweis;
  update intern.pv_nachholen_versuch set ergebnis = 'zaehler ' || kwh || ' kWh' where sn = a.sn and tag = a.tag;
end $$;

revoke all on function intern.pv_nachholen_senden() from public, anon, authenticated;
revoke all on function intern.pv_nachholen_verarbeiten() from public, anon, authenticated;

select cron.schedule('pv_nachholen_senden', '3-59/10 * * * *', 'select intern.pv_nachholen_senden()');
select cron.schedule('pv_nachholen_verarbeiten', '4-59/10 * * * *', 'select intern.pv_nachholen_verarbeiten()');
