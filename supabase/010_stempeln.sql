-- 010: Personen mit Rollen und Bereich „Stempeln“ (Arbeitszeiten der Mitarbeiter)
--   chef        = Christian und Carolin: sehen und dürfen alles, geben Nachträge frei
--   mitarbeiter = sieht nur „Stempeln“ und nur die eigenen Zeiten
-- Neue Konten werden automatisch als mitarbeiter angelegt (am wenigsten Rechte).
-- Ab hier dürfen alle bisherigen Bereiche (Energie, PV, Störungen, Einstellungen) nur noch chef lesen.
-- Stempel werden nie gelöscht oder geändert: Nachträge kommen als eigene Zeile dazu,
-- der Chef gibt sie frei oder lehnt sie ab (wer und wann wird gespeichert).

-- ---------- Personen und Rollen ----------
create table if not exists public.personen (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  rolle text not null default 'mitarbeiter' check (rolle in ('chef', 'mitarbeiter')),
  stempelt boolean not null default true,
  angelegt_am timestamptz not null default now()
);
alter table public.personen enable row level security;
revoke all on public.personen from public, anon, authenticated;
grant select on public.personen to authenticated;

-- Ist der Angemeldete Chef (mit Code angemeldet)?
create or replace function public.ist_chef()
returns boolean language sql stable security definer set search_path = '' as $$
  select (auth.jwt() ->> 'aal') = 'aal2'
     and exists (select 1 from public.personen p where p.user_id = auth.uid() and p.rolle = 'chef');
$$;
revoke all on function public.ist_chef() from public, anon, authenticated;
grant execute on function public.ist_chef() to authenticated;

create policy "Eigene Zeile oder Chef" on public.personen for select to authenticated
  using ((auth.jwt() ->> 'aal') = 'aal2' and (user_id = auth.uid() or public.ist_chef()));

-- Neue Konten automatisch als Mitarbeiter eintragen (Name vorläufig aus der E-Mail)
create or replace function intern.person_anlegen()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.personen (user_id, name) values (new.id, split_part(new.email, '@', 1))
  on conflict (user_id) do nothing;
  return new;
end $$;
revoke all on function intern.person_anlegen() from public, anon, authenticated;
create trigger person_anlegen after insert on auth.users
  for each row execute function intern.person_anlegen();

-- Alle bis jetzt angelegten Konten (Christian und Carolin) sind Chef und stempeln nicht
insert into public.personen (user_id, name, rolle, stempelt)
select id, initcap(split_part(split_part(email, '@', 1), '.', 1)), 'chef', false from auth.users
on conflict (user_id) do nothing;

-- Eigene Angaben für die App (Rolle entscheidet, was angezeigt wird)
create or replace function public.mein_profil()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_build_object('name', p.name, 'rolle', p.rolle, 'stempelt', p.stempelt)
                     from public.personen p where p.user_id = auth.uid()),
                  jsonb_build_object('name', null, 'rolle', 'mitarbeiter', 'stempelt', false));
$$;
revoke all on function public.mein_profil() from public, anon, authenticated;
grant execute on function public.mein_profil() to authenticated;

-- ---------- Bisherige Bereiche nur noch für Chef ----------
do $$
declare t text;
begin
  foreach t in array array['energie_zuhause', 'bilder', 'pv_wechselrichter', 'pv_live', 'pv_tag', 'pv_abruf', 'stoerungen', 'einstellungen'] loop
    -- Bestehende Leseregel nur verschärfen (Name bleibt), nichts wird gelöscht
    execute format('alter policy "Lesen nur nach Anmeldung mit Code" on public.%I using (public.ist_chef())', t);
  end loop;
end $$;

-- Schreibende Funktionen der bisherigen Bereiche ebenfalls nur für Chef
create or replace function public.push_abo_speichern(p_endpoint text, p_p256dh text, p_auth text, p_geraet text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.ist_chef() then raise exception 'Nur für Christian und Carolin' using errcode = '42501'; end if;
  insert into public.push_abos (user_id, endpoint, p256dh, auth, geraet)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, p_geraet)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh,
    auth = excluded.auth, geraet = excluded.geraet, fehler = null;
end $$;

create or replace function public.push_test()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.ist_chef() then raise exception 'Nur für Christian und Carolin' using errcode = '42501'; end if;
  perform intern.push_ausloesen(jsonb_build_array(jsonb_build_object(
    'titel', 'Betrieb Aumeier', 'text', 'Testmitteilung: Die Mitteilungen funktionieren.', 'ziel', '#')), auth.uid());
end $$;

create or replace function public.stoerung_gelesen(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.ist_chef() then raise exception 'Nur für Christian und Carolin' using errcode = '42501'; end if;
  update public.stoerungen
     set gelesen_am = now(), gelesen_von = auth.uid(), gelesen_email = auth.jwt() ->> 'email'
   where id = p_id and gelesen_am is null;
end $$;

create or replace function public.einstellung_setzen(p_name text, p_wert jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.ist_chef() then raise exception 'Nur für Christian und Carolin' using errcode = '42501'; end if;
  if p_name = 'wallbox_mindest_soc' then
    if jsonb_typeof(p_wert) <> 'number' or (p_wert #>> '{}')::numeric not between 0 and 100 then
      raise exception 'Wert muss eine Zahl zwischen 0 und 100 sein' using errcode = '22023';
    end if;
    p_wert := to_jsonb(round((p_wert #>> '{}')::numeric));
  else
    raise exception 'Unbekannte Einstellung: %', p_name using errcode = '22023';
  end if;
  insert into public.einstellungen (name, wert, geaendert_am, geaendert_von)
  values (p_name, p_wert, now(), auth.jwt() ->> 'email')
  on conflict (name) do update set wert = excluded.wert, geaendert_am = now(), geaendert_von = excluded.geaendert_von;
end $$;

-- ---------- Stempel ----------
-- art: start, pause, weiter (nach der Pause), stopp
-- status: gueltig; offen (Nachtrag wartet auf Freigabe); abgelehnt
create table if not exists public.stempel (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id),
  art text not null check (art in ('start', 'pause', 'weiter', 'stopp')),
  zeit timestamptz not null,
  nachtrag boolean not null default false,
  grund text,
  status text not null default 'gueltig' check (status in ('gueltig', 'offen', 'abgelehnt')),
  angelegt_am timestamptz not null default now(),
  angelegt_von uuid not null,
  entschieden_am timestamptz,
  entschieden_von uuid
);
create index if not exists stempel_user_zeit on public.stempel (user_id, zeit);
alter table public.stempel enable row level security;
revoke all on public.stempel from public, anon, authenticated;
grant select on public.stempel to authenticated;
create policy "Eigene Stempel oder Chef" on public.stempel for select to authenticated
  using ((auth.jwt() ->> 'aal') = 'aal2' and (user_id = auth.uid() or public.ist_chef()));

-- Zustand einer Person: letzter Stempel (gültig oder wartend), aus = noch nie oder Stopp
create or replace function intern.stempel_zustand(p_user uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case coalesce((select s.art from public.stempel s
                         where s.user_id = p_user and s.status <> 'abgelehnt' and s.zeit <= now()
                         order by s.zeit desc, s.id desc limit 1), 'stopp')
           when 'stopp' then 'aus' when 'pause' then 'pause' else 'arbeitet' end;
$$;
revoke all on function intern.stempel_zustand(uuid) from public, anon, authenticated;

-- Knopf drücken: Zeit setzt immer der Server (jetzt)
create or replace function public.stempeln(p_art text)
returns void language plpgsql security definer set search_path = '' as $$
declare z text;
begin
  if auth.uid() is null or (auth.jwt() ->> 'aal') is distinct from 'aal2' then
    raise exception 'Nur nach Anmeldung mit Code' using errcode = '42501';
  end if;
  if not exists (select 1 from public.personen where user_id = auth.uid() and stempelt) then
    raise exception 'Für dieses Konto ist Stempeln nicht vorgesehen' using errcode = '42501';
  end if;
  z := intern.stempel_zustand(auth.uid());
  if not ((z = 'aus' and p_art = 'start')
       or (z = 'arbeitet' and p_art in ('pause', 'stopp'))
       or (z = 'pause' and p_art in ('weiter', 'stopp'))) then
    raise exception 'Das passt gerade nicht (Zustand: %, Knopf: %). Bitte die Seite neu laden.', z, p_art using errcode = '22023';
  end if;
  insert into public.stempel (user_id, art, zeit, angelegt_von) values (auth.uid(), p_art, now(), auth.uid());
end $$;

-- Nachtragen: Mitarbeiter für sich (wartet auf Freigabe), Chef für jeden (gilt sofort)
create or replace function public.stempel_nachtragen(p_art text, p_zeit timestamptz, p_grund text, p_user uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare wer uuid := coalesce(p_user, auth.uid());
        chef boolean := public.ist_chef();
begin
  if auth.uid() is null or (auth.jwt() ->> 'aal') is distinct from 'aal2' then
    raise exception 'Nur nach Anmeldung mit Code' using errcode = '42501';
  end if;
  if wer <> auth.uid() and not chef then
    raise exception 'Nur für Christian und Carolin' using errcode = '42501';
  end if;
  if not exists (select 1 from public.personen where user_id = wer and stempelt) then
    raise exception 'Für diese Person ist Stempeln nicht vorgesehen' using errcode = '22023';
  end if;
  if p_art not in ('start', 'pause', 'weiter', 'stopp') then
    raise exception 'Unbekannte Art: %', p_art using errcode = '22023';
  end if;
  if p_zeit > now() + interval '1 minute' then
    raise exception 'Die Zeit liegt in der Zukunft' using errcode = '22023';
  end if;
  if p_zeit < now() - interval '62 days' and not chef then
    raise exception 'Nachtragen geht nur für die letzten zwei Monate' using errcode = '22023';
  end if;
  if coalesce(btrim(p_grund), '') = '' then
    raise exception 'Bitte einen Grund angeben' using errcode = '22023';
  end if;
  insert into public.stempel (user_id, art, zeit, nachtrag, grund, status, angelegt_von, entschieden_am, entschieden_von)
  values (wer, p_art, p_zeit, true, btrim(p_grund), case when chef then 'gueltig' else 'offen' end, auth.uid(),
          case when chef then now() end, case when chef then auth.uid() end);
end $$;

-- Freigeben oder ablehnen (nur Chef, nur wartende Nachträge)
create or replace function public.nachtrag_entscheiden(p_id bigint, p_ok boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.ist_chef() then raise exception 'Nur für Christian und Carolin' using errcode = '42501'; end if;
  update public.stempel
     set status = case when p_ok then 'gueltig' else 'abgelehnt' end, entschieden_am = now(), entschieden_von = auth.uid()
   where id = p_id and status = 'offen';
  if not found then raise exception 'Dieser Nachtrag ist schon entschieden' using errcode = '22023'; end if;
end $$;

revoke all on function public.stempeln(text) from public, anon, authenticated;
revoke all on function public.stempel_nachtragen(text, timestamptz, text, uuid) from public, anon, authenticated;
revoke all on function public.nachtrag_entscheiden(bigint, boolean) from public, anon, authenticated;
grant execute on function public.stempeln(text) to authenticated;
grant execute on function public.stempel_nachtragen(text, timestamptz, text, uuid) to authenticated;
grant execute on function public.nachtrag_entscheiden(bigint, boolean) to authenticated;
