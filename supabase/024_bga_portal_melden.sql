-- 024: Der angemeldete Bayernwerk-Tab in Chrome (Büro-PC) meldet selbst an Supabase.
-- Ein kleines Skript im Tab hält die Sitzung wach (alle 4 min), liest einmal am Tag alle
-- Lastgänge aus und schickt sie über rpc/bga_portal_melden (Parameter p_schluessel,
-- Schlüssel steht nur im Browser, hier nur sein Hash in intern.schluessel, Name 'bga_portal').

create table if not exists public.bga_portal_status (
  id int primary key default 1 check (id = 1),
  letzter_kontakt timestamptz,
  angemeldet boolean,
  letzte_auslesung timestamptz,
  text text
);
insert into public.bga_portal_status (id) values (1) on conflict do nothing;
alter table public.bga_portal_status enable row level security;
create policy bga_status_chef on public.bga_portal_status for select to authenticated using (public.ist_chef());
grant select on public.bga_portal_status to authenticated;

-- p_art: 'wachhalten' (nur Lebenszeichen), 'abgemeldet', 'auslesen' (p_daten = Liste der Einträge
-- {energieart, meldepunkt, obis, zaehler, werte: [[ms, kwh], ...]})
-- Schlüssel als Parameter statt Kopfzeile: eigene Kopfzeilen lässt der Browser (CORS) nicht sicher durch.
create or replace function public.bga_portal_melden(p_schluessel text, p_art text, p_daten jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  k text := p_schluessel;
  e jsonb;
  n int := 0;
begin
  if k is null or not exists (
    select 1 from intern.schluessel s
    where s.name = 'bga_portal' and s.hash = encode(sha256(convert_to(k, 'UTF8')), 'hex')
  ) then
    raise exception 'Schlüssel ungültig' using errcode = '42501';
  end if;

  if p_art = 'auslesen' then
    for e in select * from jsonb_array_elements(p_daten) loop
      n := n + intern.bga_lastgang_speichern(e->>'energieart', e->>'meldepunkt', e->>'obis', e->>'zaehler', e->'werte');
    end loop;
    insert into public.bga_portal_abruf (art, ok, text)
      values ('auslesen', true, jsonb_array_length(p_daten) || ' Einträge, ' || n || ' Viertelstunden');
    update public.bga_portal_status set letzter_kontakt = now(), angemeldet = true, letzte_auslesung = now(), text = null where id = 1;
  elsif p_art = 'abgemeldet' then
    insert into public.bga_portal_abruf (art, ok, text) values ('wachhalten', false, coalesce(p_daten->>'text', 'abgemeldet'));
    update public.bga_portal_status set letzter_kontakt = now(), angemeldet = false, text = p_daten->>'text' where id = 1;
  else
    update public.bga_portal_status set letzter_kontakt = now(), angemeldet = true where id = 1;
  end if;
  return jsonb_build_object('ok', true, 'viertelstunden', n);
end $$;

grant execute on function public.bga_portal_melden(text, text, jsonb) to anon, authenticated;

-- Überwachung (pg_cron alle 5 min): Störung „wichtig“ → Push über intern.stoerungen_pruefen
create or replace function intern.bga_portal_pruefen()
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare st public.bga_portal_status;
begin
  select * into st from public.bga_portal_status where id = 1;
  if st.letzter_kontakt is null then
    return;
  elsif st.angemeldet = false then
    perform intern.stoerung_setzen('bga_portal', 'Bayernwerk-Portal', 'wichtig',
      'Bayernwerk hat abgemeldet. Bitte am Büro-PC im Chrome-Tab neu anmelden und Claude Bescheid geben.', st.letzter_kontakt);
  elsif st.letzter_kontakt < now() - interval '20 minutes' then
    perform intern.stoerung_setzen('bga_portal', 'Bayernwerk-Portal', 'wichtig',
      'Der Bayernwerk-Tab meldet sich seit ' || to_char(st.letzter_kontakt at time zone 'Europe/Berlin', 'DD.MM. HH24:MI') ||
      ' Uhr nicht (abgemeldet, PC aus oder Chrome zu).', st.letzter_kontakt);
  else
    perform intern.stoerung_beheben('bga_portal');
    if st.letzte_auslesung is not null and st.letzte_auslesung < now() - interval '30 hours' then
      perform intern.stoerung_setzen('bga_portal_auslesen', 'Bayernwerk-Portal', 'hinweis',
        'Lastgänge seit ' || to_char(st.letzte_auslesung at time zone 'Europe/Berlin', 'DD.MM. HH24:MI') || ' Uhr nicht mehr ausgelesen.', st.letzte_auslesung);
    else
      perform intern.stoerung_beheben('bga_portal_auslesen');
    end if;
  end if;
end $$;

select cron.schedule('bga_portal_pruefen', '1-59/5 * * * *', 'select intern.bga_portal_pruefen()');
