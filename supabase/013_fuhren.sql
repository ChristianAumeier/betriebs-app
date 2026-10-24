-- 013: Bereich „Bahnschwellen“: Fuhren mit ihren Belegen (Lieferschein, Begleitschein, Registerbeleg, Wiegeschein)
--   Fahrer scannen Lieferschein und Begleitschein, senden die Fuhre an die Transportfirma, scannen in Nürnberg den Wiegeschein.
--   Die Transportfirma (eigener Zugang) sieht die Fuhren, signiert selbst in ZEDAL und legt den Registerbeleg zur Fuhre.
--   Ist eine Fuhre komplett (Lieferschein, Begleitschein, Wiegeschein), gibt die Edge Function fuhren-github die Scans
--   in das private Repository claude-gedaechtnis; das startet eine Claude-Routine, die liest und das Ergebnis dort ablegt.
--   Supabase holt die Ergebnisse alle 10 Minuten ab (fuhren-github, aktion „abgleichen“).
-- Rollen: chef sieht alles inkl. Euro; personen.fuhren = 'fahrer' (alle Fuhren unseres LKW, keine Euro) oder
--   'transportfirma' (alle Fuhren, keine Euro, darf nur den Registerbeleg ablegen).
-- Nichts wird gelöscht: falsche Scans werden als ungültig markiert, Fuhren storniert.
-- Ohne „drop“ geschrieben (siehe Lehre in CLAUDE.md).

-- ---------- Rollen ----------
alter table public.personen add column if not exists fuhren text check (fuhren in ('fahrer', 'transportfirma'));

-- Was darf der Angemeldete im Bereich Bahnschwellen? chef / fahrer / transportfirma / null
create or replace function public.fuhren_rolle()
returns text language sql stable security definer set search_path = '' as $$
  select case when (auth.jwt() ->> 'aal') is distinct from 'aal2' then null
              else (select case when p.rolle = 'chef' then 'chef' else p.fuhren end
                      from public.personen p where p.user_id = auth.uid()) end;
$$;
revoke all on function public.fuhren_rolle() from public, anon, authenticated;
grant execute on function public.fuhren_rolle() to authenticated;

create or replace function public.mein_profil()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_build_object('name', p.name, 'rolle', p.rolle, 'stempelt', p.stempelt, 'fuhren', p.fuhren)
                     from public.personen p where p.user_id = auth.uid()),
                  jsonb_build_object('name', null, 'rolle', 'mitarbeiter', 'stempelt', false, 'fuhren', null));
$$;

-- Chef: Zugang zu den Fuhren für eine Person setzen (null = kein Zugang)
create or replace function public.person_fuhren_setzen(p_user uuid, p_fuhren text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.ist_chef() then raise exception 'Nur für Christian und Carolin' using errcode = '42501'; end if;
  if p_fuhren is not null and p_fuhren not in ('fahrer', 'transportfirma') then
    raise exception 'Unbekannter Zugang: %', p_fuhren using errcode = '22023';
  end if;
  update public.personen set fuhren = p_fuhren where user_id = p_user and rolle <> 'chef';
  if not found then raise exception 'Person nicht gefunden (oder Chef)' using errcode = '22023'; end if;
end $$;
revoke all on function public.person_fuhren_setzen(uuid, text) from public, anon, authenticated;
grant execute on function public.person_fuhren_setzen(uuid, text) to authenticated;

-- ---------- Ladestellen und Preise ----------
create table if not exists public.ladestellen (
  id bigint generated always as identity primary key,
  vertrag text not null unique,            -- Vertragsnummer, z. B. 88783
  name text not null,                      -- wie in der Auswertung, z. B. „3386 Plattling“
  aktiv boolean not null default true,
  angelegt_am timestamptz not null default now(),
  angelegt_von text
);
alter table public.ladestellen enable row level security;
revoke all on public.ladestellen from public, anon, authenticated;
grant select on public.ladestellen to authenticated;
create policy "Fuhren-Berechtigte" on public.ladestellen for select to authenticated using (public.fuhren_rolle() is not null);

-- Euro je Schwelle, gültig ab Datum (nur Chef)
create table if not exists public.ladestellen_preise (
  id bigint generated always as identity primary key,
  ladestelle_id bigint not null references public.ladestellen(id),
  gueltig_ab date not null,
  preis_schwelle numeric(8,2) not null check (preis_schwelle >= 0),
  angelegt_am timestamptz not null default now(),
  angelegt_von text,
  unique (ladestelle_id, gueltig_ab)
);
alter table public.ladestellen_preise enable row level security;
revoke all on public.ladestellen_preise from public, anon, authenticated;
grant select on public.ladestellen_preise to authenticated;
create policy "Nur Chef" on public.ladestellen_preise for select to authenticated using (public.ist_chef());

-- Chef: Ladestelle anlegen oder umbenennen, Preis ab einem Tag setzen
create or replace function public.ladestelle_speichern(p_vertrag text, p_name text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare i bigint;
begin
  if not public.ist_chef() then raise exception 'Nur für Christian und Carolin' using errcode = '42501'; end if;
  if coalesce(btrim(p_vertrag), '') = '' or coalesce(btrim(p_name), '') = '' then
    raise exception 'Bitte Vertragsnummer und Namen angeben' using errcode = '22023';
  end if;
  insert into public.ladestellen (vertrag, name, angelegt_von) values (btrim(p_vertrag), btrim(p_name), auth.jwt() ->> 'email')
  on conflict (vertrag) do update set name = excluded.name
  returning id into i;
  return i;
end $$;

create or replace function public.preis_setzen(p_ladestelle bigint, p_gueltig_ab date, p_preis numeric)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.ist_chef() then raise exception 'Nur für Christian und Carolin' using errcode = '42501'; end if;
  if p_preis is null or p_preis < 0 then raise exception 'Bitte einen Preis angeben' using errcode = '22023'; end if;
  insert into public.ladestellen_preise (ladestelle_id, gueltig_ab, preis_schwelle, angelegt_von)
  values (p_ladestelle, p_gueltig_ab, round(p_preis, 2), auth.jwt() ->> 'email')
  on conflict (ladestelle_id, gueltig_ab) do update set preis_schwelle = excluded.preis_schwelle,
    angelegt_am = now(), angelegt_von = excluded.angelegt_von;
end $$;
revoke all on function public.ladestelle_speichern(text, text) from public, anon, authenticated;
revoke all on function public.preis_setzen(bigint, date, numeric) from public, anon, authenticated;
grant execute on function public.ladestelle_speichern(text, text) to authenticated;
grant execute on function public.preis_setzen(bigint, date, numeric) to authenticated;

-- ---------- Fuhren ----------
create table if not exists public.fuhren (
  id bigint generated always as identity primary key,
  datum date not null,                     -- Ladetag
  lkw text not null default 'R-AC 5005',
  ladestelle_id bigint references public.ladestellen(id),
  fahrer text,                             -- wie auf dem Lieferschein; zwei Namen „A / B“ = einer hat vorgeladen
  stueck integer check (stueck between 0 and 1000),
  gewicht_t numeric(7,2),
  abladezeit interval,                     -- Differenz der zwei Wiege-Uhrzeiten
  begleitschein_nr text,
  auftrag_nr text,                         -- Auftragsnummer auf dem Wiegeschein
  lieferschein_nr text,
  hinweise text,                           -- Auffälligkeiten beim Auslesen
  auffaellig boolean not null default false,
  quelle text not null default 'app' check (quelle in ('app', 'altbestand')),
  abgesendet_am timestamptz,               -- an die Transportfirma geschickt
  weitergabe_angestossen_am timestamptz,
  weitergegeben_am timestamptz,            -- Scans liegen im Repository für die Routine
  weitergabe_fehler text,
  ausgelesen_am timestamptz,
  ergebnis jsonb,                          -- Ergebnis der Routine, wie geliefert
  ergebnis_sha text,
  storniert_am timestamptz,
  storniert_von text,
  storno_grund text,
  angelegt_am timestamptz not null default now(),
  angelegt_von uuid,
  geaendert_am timestamptz,
  geaendert_von text
);
create index if not exists fuhren_datum on public.fuhren (datum);
alter table public.fuhren enable row level security;
revoke all on public.fuhren from public, anon, authenticated;
grant select on public.fuhren to authenticated;
create policy "Fuhren-Berechtigte" on public.fuhren for select to authenticated using (public.fuhren_rolle() is not null);

create table if not exists public.belege (
  id bigint generated always as identity primary key,
  fuhre_id bigint not null references public.fuhren(id),
  art text not null check (art in ('lieferschein', 'begleitschein', 'registerbeleg', 'wiegeschein', 'altscan')),
  pfad text not null unique,               -- im privaten Speicher „belege“: fuhren/<fuhre>/<art>-<zufall>.<endung>
  mime text not null,
  groesse integer,
  angelegt_am timestamptz not null default now(),
  angelegt_von uuid,
  ungueltig_am timestamptz,
  ungueltig_von text,
  ungueltig_grund text
);
create index if not exists belege_fuhre on public.belege (fuhre_id, art, id);
alter table public.belege enable row level security;
revoke all on public.belege from public, anon, authenticated;
grant select on public.belege to authenticated;
create policy "Fuhren-Berechtigte" on public.belege for select to authenticated using (public.fuhren_rolle() is not null);

-- Edge Function fuhren-github liest und schreibt mit service_role
grant select, update on public.fuhren to service_role;
grant select on public.belege, public.ladestellen to service_role;

-- Übersicht für die App: Fuhre mit Ladestelle und welche Belege da sind (Rechte wie bei den Tabellen)
create or replace view public.fuhren_liste with (security_invoker = true) as
select f.id, f.datum, f.lkw, f.ladestelle_id, l.name as ladestelle, l.vertrag, f.fahrer, f.stueck, f.gewicht_t,
       to_char(f.abladezeit, 'HH24:MI:SS') as abladezeit, f.begleitschein_nr, f.auftrag_nr, f.lieferschein_nr,
       f.hinweise, f.auffaellig, f.quelle, f.abgesendet_am, f.weitergegeben_am, f.weitergabe_fehler, f.ausgelesen_am,
       f.storniert_am, f.storno_grund, f.angelegt_am, f.angelegt_von,
       (select p.name from public.personen p where p.user_id = f.angelegt_von) as angelegt_von_name,
       exists (select 1 from public.belege b where b.fuhre_id = f.id and b.ungueltig_am is null and b.art = 'lieferschein') as hat_lieferschein,
       exists (select 1 from public.belege b where b.fuhre_id = f.id and b.ungueltig_am is null and b.art = 'begleitschein') as hat_begleitschein,
       exists (select 1 from public.belege b where b.fuhre_id = f.id and b.ungueltig_am is null and b.art = 'registerbeleg') as hat_registerbeleg,
       exists (select 1 from public.belege b where b.fuhre_id = f.id and b.ungueltig_am is null and b.art = 'wiegeschein') as hat_wiegeschein,
       exists (select 1 from public.belege b where b.fuhre_id = f.id and b.ungueltig_am is null and b.art = 'altscan') as hat_altscan
  from public.fuhren f left join public.ladestellen l on l.id = f.ladestelle_id;
revoke all on public.fuhren_liste from public, anon, authenticated;
grant select on public.fuhren_liste to authenticated;

-- ---------- Privater Speicher für die Scans ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('belege', 'belege', false, 15728640, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

create policy "Belege lesen" on storage.objects for select to authenticated
  using (bucket_id = 'belege' and public.fuhren_rolle() is not null);
-- Hochladen: Chef und Fahrer alle Arten, Transportfirma nur den Registerbeleg. Ändern/Löschen gibt es nicht.
create policy "Belege hochladen" on storage.objects for insert to authenticated
  with check (bucket_id = 'belege' and split_part(name, '/', 1) = 'fuhren'
              and (public.fuhren_rolle() in ('chef', 'fahrer')
                   or (public.fuhren_rolle() = 'transportfirma' and split_part(name, '/', 3) like 'registerbeleg-%')));

-- ---------- Abläufe ----------
create or replace function intern.fuhren_pruefen_rolle(p_erlaubt text[])
returns text language plpgsql stable security definer set search_path = '' as $$
declare r text := public.fuhren_rolle();
begin
  if r is null or not (r = any (p_erlaubt)) then
    raise exception 'Dafür fehlt die Berechtigung' using errcode = '42501';
  end if;
  return r;
end $$;
revoke all on function intern.fuhren_pruefen_rolle(text[]) from public, anon, authenticated;

-- Neue Fuhre (Fahrer oder Chef). Fahrer = Name des Angemeldeten, falls nichts angegeben.
create or replace function public.fuhre_anlegen(p_datum date, p_ladestelle bigint default null, p_fahrer text default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare i bigint;
        heute date := (now() at time zone 'Europe/Berlin')::date;
begin
  perform intern.fuhren_pruefen_rolle(array['chef', 'fahrer']);
  if p_datum is null or p_datum > heute + 1 or p_datum < heute - 62 then
    raise exception 'Das Datum muss zwischen % und morgen liegen', to_char(heute - 62, 'DD.MM.YYYY') using errcode = '22023';
  end if;
  insert into public.fuhren (datum, ladestelle_id, fahrer, angelegt_von)
  values (p_datum, p_ladestelle,
          coalesce(nullif(btrim(p_fahrer), ''), (select p.name from public.personen p where p.user_id = auth.uid())),
          auth.uid())
  returning id into i;
  return i;
end $$;

-- Ein hochgeladener Scan wird der Fuhre zugeordnet
create or replace function public.beleg_eintragen(p_fuhre bigint, p_art text, p_pfad text, p_mime text, p_groesse integer)
returns bigint language plpgsql security definer set search_path = '' as $$
declare r text;
        i bigint;
        f public.fuhren%rowtype;
begin
  r := intern.fuhren_pruefen_rolle(array['chef', 'fahrer', 'transportfirma']);
  if p_art not in ('lieferschein', 'begleitschein', 'registerbeleg', 'wiegeschein') then
    raise exception 'Unbekannte Belegart: %', p_art using errcode = '22023';
  end if;
  if r = 'transportfirma' and p_art <> 'registerbeleg' then
    raise exception 'Die Transportfirma legt nur den Registerbeleg ab' using errcode = '42501';
  end if;
  select * into f from public.fuhren where id = p_fuhre;
  if not found or f.storniert_am is not null then raise exception 'Fuhre nicht gefunden oder storniert' using errcode = '22023'; end if;
  if p_pfad not like 'fuhren/' || p_fuhre || '/' || p_art || '-%' then
    raise exception 'Speicherpfad passt nicht zur Fuhre' using errcode = '22023';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'belege' and o.name = p_pfad) then
    raise exception 'Der Scan ist nicht im Speicher angekommen' using errcode = '22023';
  end if;
  insert into public.belege (fuhre_id, art, pfad, mime, groesse, angelegt_von)
  values (p_fuhre, p_art, p_pfad, p_mime, p_groesse, auth.uid())
  returning id into i;

  if p_art = 'registerbeleg' then
    -- Der Fahrer, der die Fuhre angelegt hat, erfährt es
    perform intern.push_an(jsonb_build_array(jsonb_build_object(
      'titel', 'Registerbeleg da',
      'text', 'Fuhre vom ' || to_char(f.datum, 'DD.MM.') || coalesce(' – ' || (select l.name from public.ladestellen l where l.id = f.ladestelle_id), '') || ': Die Transportfirma hat den Registerbeleg abgelegt.',
      'ziel', '#bahnschwellen/' || p_fuhre)),
      case when f.angelegt_von is not null and f.angelegt_von <> auth.uid() then array[f.angelegt_von] else '{}'::uuid[] end);
  end if;
  perform intern.fuhre_komplett_pruefen(p_fuhre);
  return i;
end $$;

-- Falscher Scan: als ungültig markieren (bleibt gespeichert). Wer ihn abgelegt hat oder Chef.
create or replace function public.beleg_ungueltig(p_beleg bigint, p_grund text)
returns void language plpgsql security definer set search_path = '' as $$
declare r text;
begin
  r := intern.fuhren_pruefen_rolle(array['chef', 'fahrer', 'transportfirma']);
  if coalesce(btrim(p_grund), '') = '' then raise exception 'Bitte einen Grund angeben' using errcode = '22023'; end if;
  update public.belege set ungueltig_am = now(), ungueltig_von = auth.jwt() ->> 'email', ungueltig_grund = btrim(p_grund)
   where id = p_beleg and ungueltig_am is null and (r = 'chef' or angelegt_von = auth.uid());
  if not found then raise exception 'Nur wer den Scan abgelegt hat (oder Christian/Carolin) kann ihn als falsch markieren' using errcode = '42501'; end if;
end $$;

-- An die Transportfirma senden (Lieferschein und Begleitschein müssen da sein)
create or replace function public.fuhre_absenden(p_fuhre bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare f public.fuhren_liste%rowtype;
begin
  perform intern.fuhren_pruefen_rolle(array['chef', 'fahrer']);
  select * into f from public.fuhren_liste where id = p_fuhre;
  if not found or f.storniert_am is not null then raise exception 'Fuhre nicht gefunden oder storniert' using errcode = '22023'; end if;
  if not (f.hat_lieferschein and f.hat_begleitschein) then
    raise exception 'Bitte zuerst Lieferschein und Begleitschein scannen' using errcode = '22023';
  end if;
  if f.abgesendet_am is not null then return; end if;
  update public.fuhren set abgesendet_am = now() where id = p_fuhre;
  perform intern.push_an(jsonb_build_array(jsonb_build_object(
    'titel', 'Neue Fuhre – bitte signieren',
    'text', f.lkw || ' · ' || to_char(f.datum, 'DD.MM.YYYY') || coalesce(' · ' || f.ladestelle, '') || coalesce(' · ' || f.fahrer, ''),
    'ziel', '#bahnschwellen/' || p_fuhre)),
    (select coalesce(array_agg(p.user_id), '{}') from public.personen p where p.fuhren = 'transportfirma'));
end $$;

-- Chef: Werte einer Fuhre von Hand berichtigen (z. B. nach dem Auslesen)
create or replace function public.fuhre_aendern(p_fuhre bigint, p_werte jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.ist_chef() then raise exception 'Nur für Christian und Carolin' using errcode = '42501'; end if;
  update public.fuhren set
    datum = coalesce((p_werte ->> 'datum')::date, datum),
    ladestelle_id = case when p_werte ? 'ladestelle_id' then (p_werte ->> 'ladestelle_id')::bigint else ladestelle_id end,
    fahrer = case when p_werte ? 'fahrer' then nullif(btrim(p_werte ->> 'fahrer'), '') else fahrer end,
    stueck = case when p_werte ? 'stueck' then (p_werte ->> 'stueck')::integer else stueck end,
    gewicht_t = case when p_werte ? 'gewicht_t' then (p_werte ->> 'gewicht_t')::numeric else gewicht_t end,
    abladezeit = case when p_werte ? 'abladezeit' then nullif(p_werte ->> 'abladezeit', '')::interval else abladezeit end,
    begleitschein_nr = case when p_werte ? 'begleitschein_nr' then nullif(btrim(p_werte ->> 'begleitschein_nr'), '') else begleitschein_nr end,
    auftrag_nr = case when p_werte ? 'auftrag_nr' then nullif(btrim(p_werte ->> 'auftrag_nr'), '') else auftrag_nr end,
    lieferschein_nr = case when p_werte ? 'lieferschein_nr' then nullif(btrim(p_werte ->> 'lieferschein_nr'), '') else lieferschein_nr end,
    auffaellig = coalesce((p_werte ->> 'auffaellig')::boolean, auffaellig),
    hinweise = case when p_werte ? 'hinweise' then nullif(btrim(p_werte ->> 'hinweise'), '') else hinweise end,
    geaendert_am = now(), geaendert_von = auth.jwt() ->> 'email'
  where id = p_fuhre;
  if not found then raise exception 'Fuhre nicht gefunden' using errcode = '22023'; end if;
end $$;

create or replace function public.fuhre_stornieren(p_fuhre bigint, p_grund text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.ist_chef() then raise exception 'Nur für Christian und Carolin' using errcode = '42501'; end if;
  if coalesce(btrim(p_grund), '') = '' then raise exception 'Bitte einen Grund angeben' using errcode = '22023'; end if;
  update public.fuhren set storniert_am = now(), storniert_von = auth.jwt() ->> 'email', storno_grund = btrim(p_grund)
   where id = p_fuhre and storniert_am is null;
  if not found then raise exception 'Fuhre nicht gefunden oder schon storniert' using errcode = '22023'; end if;
end $$;

revoke all on function public.fuhre_anlegen(date, bigint, text) from public, anon, authenticated;
revoke all on function public.beleg_eintragen(bigint, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.beleg_ungueltig(bigint, text) from public, anon, authenticated;
revoke all on function public.fuhre_absenden(bigint) from public, anon, authenticated;
revoke all on function public.fuhre_aendern(bigint, jsonb) from public, anon, authenticated;
revoke all on function public.fuhre_stornieren(bigint, text) from public, anon, authenticated;
grant execute on function public.fuhre_anlegen(date, bigint, text) to authenticated;
grant execute on function public.beleg_eintragen(bigint, text, text, text, integer) to authenticated;
grant execute on function public.beleg_ungueltig(bigint, text) to authenticated;
grant execute on function public.fuhre_absenden(bigint) to authenticated;
grant execute on function public.fuhre_aendern(bigint, jsonb) to authenticated;
grant execute on function public.fuhre_stornieren(bigint, text) to authenticated;

-- ---------- Mitteilungen gezielt an Personen ----------
-- push-senden kennt jetzt „an_users“. Störungen gehen ab hier nur an die Chefs (vorher an alle Geräte).
create or replace function intern.push_an(p_nachrichten jsonb, p_users uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  if jsonb_array_length(p_nachrichten) = 0 or coalesce(array_length(p_users, 1), 0) = 0 then return; end if;
  perform net.http_post(
    url := 'https://trwazyqryqdjbfggaufd.supabase.co/functions/v1/push-senden',
    body := jsonb_build_object('nachrichten', p_nachrichten, 'an_users', to_jsonb(p_users)),
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-push-ausloeser', (select decrypted_secret from vault.decrypted_secrets where name = 'push_ausloeser')),
    timeout_milliseconds := 30000);
end $$;
revoke all on function intern.push_an(jsonb, uuid[]) from public, anon, authenticated;

create or replace function intern.push_ausloesen(p_nachrichten jsonb, p_nur_user uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform intern.push_an(p_nachrichten,
    case when p_nur_user is not null then array[p_nur_user]
         else (select coalesce(array_agg(p.user_id), '{}') from public.personen p where p.rolle = 'chef') end);
end $$;

-- Mitteilungen erlauben dürfen jetzt auch Fahrer und Transportfirma
create or replace function public.push_abo_speichern(p_endpoint text, p_p256dh text, p_auth text, p_geraet text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.fuhren_rolle() is null then raise exception 'Mitteilungen sind für dieses Konto nicht vorgesehen' using errcode = '42501'; end if;
  insert into public.push_abos (user_id, endpoint, p256dh, auth, geraet)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, p_geraet)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh,
    auth = excluded.auth, geraet = excluded.geraet, fehler = null;
end $$;

create or replace function public.push_test()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.fuhren_rolle() is null then raise exception 'Mitteilungen sind für dieses Konto nicht vorgesehen' using errcode = '42501'; end if;
  perform intern.push_an(jsonb_build_array(jsonb_build_object(
    'titel', 'Betrieb Aumeier', 'text', 'Testmitteilung: Die Mitteilungen funktionieren.', 'ziel', '#')), array[auth.uid()]);
end $$;

-- ---------- Weitergabe an die Claude-Routine (Repository claude-gedaechtnis) ----------
-- Schlüssel für GitHub (fein eingeschränkter Token, nur dieses Repository, Inhalte lesen/schreiben).
-- Christian gibt ihn in der App ein; er liegt nur im Vault.
create or replace function public.github_schluessel_setzen(p_token text)
returns void language plpgsql security definer set search_path = '' as $$
declare i uuid;
begin
  if not public.ist_chef() then raise exception 'Nur für Christian und Carolin' using errcode = '42501'; end if;
  if coalesce(btrim(p_token), '') !~ '^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$' then
    raise exception 'Das sieht nicht wie ein GitHub-Schlüssel aus (beginnt mit github_pat_)' using errcode = '22023';
  end if;
  select id into i from vault.secrets where name = 'github_gedaechtnis';
  if i is null then
    perform vault.create_secret(btrim(p_token), 'github_gedaechtnis', 'GitHub-Token nur für claude-gedaechtnis (Fuhren)');
  else
    perform vault.update_secret(i, btrim(p_token));
  end if;
  insert into public.einstellungen (name, wert, geaendert_am, geaendert_von)
  values ('github_schluessel_gesetzt', to_jsonb(now()), now(), auth.jwt() ->> 'email')
  on conflict (name) do update set wert = excluded.wert, geaendert_am = now(), geaendert_von = excluded.geaendert_von;
end $$;
revoke all on function public.github_schluessel_setzen(text) from public, anon, authenticated;
grant execute on function public.github_schluessel_setzen(text) to authenticated;

-- Für die Edge Function: Token und Auslöser-Geheimnis
create or replace function public.fuhren_geheimnisse()
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'github', (select decrypted_secret from vault.decrypted_secrets where name = 'github_gedaechtnis'),
    'ausloeser', (select decrypted_secret from vault.decrypted_secrets where name = 'push_ausloeser'));
$$;
revoke all on function public.fuhren_geheimnisse() from public, anon, authenticated;
grant execute on function public.fuhren_geheimnisse() to service_role;

create or replace function intern.fuhren_github_aufrufen(p_body jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform net.http_post(
    url := 'https://trwazyqryqdjbfggaufd.supabase.co/functions/v1/fuhren-github',
    body := p_body,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-push-ausloeser', (select decrypted_secret from vault.decrypted_secrets where name = 'push_ausloeser')),
    timeout_milliseconds := 120000);
end $$;
revoke all on function intern.fuhren_github_aufrufen(jsonb) from public, anon, authenticated;

-- Komplett = Lieferschein, Begleitschein und Wiegeschein da → weitergeben (einmal; Wiederholung über den Zeitplan)
create or replace function intern.fuhre_komplett_pruefen(p_fuhre bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare f public.fuhren_liste%rowtype;
begin
  select * into f from public.fuhren_liste where id = p_fuhre;
  if not found or f.storniert_am is not null or f.quelle <> 'app' or f.weitergegeben_am is not null then return; end if;
  if not (f.hat_lieferschein and f.hat_begleitschein and f.hat_wiegeschein) then return; end if;
  if not exists (select 1 from vault.secrets where name = 'github_gedaechtnis') then return; end if;
  update public.fuhren set weitergabe_angestossen_am = now() where id = p_fuhre;
  perform intern.fuhren_github_aufrufen(jsonb_build_object('aktion', 'weitergeben', 'fuhre_id', p_fuhre));
end $$;
revoke all on function intern.fuhre_komplett_pruefen(bigint) from public, anon, authenticated;

-- Alle 10 Minuten: liegengebliebene Weitergaben wiederholen und Ergebnisse der Routine abholen
create or replace function intern.fuhren_abgleichen()
returns void language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if not exists (select 1 from vault.secrets where name = 'github_gedaechtnis') then return; end if;
  for r in select id from public.fuhren
            where quelle = 'app' and storniert_am is null and weitergegeben_am is null
              and (weitergabe_angestossen_am is null or weitergabe_angestossen_am < now() - interval '15 minutes') loop
    perform intern.fuhre_komplett_pruefen(r.id);
  end loop;
  if exists (select 1 from public.fuhren where weitergegeben_am is not null and ausgelesen_am is null and storniert_am is null) then
    perform intern.fuhren_github_aufrufen(jsonb_build_object('aktion', 'abgleichen'));
  end if;
end $$;
revoke all on function intern.fuhren_abgleichen() from public, anon, authenticated;
select cron.schedule('fuhren_abgleichen', '4-59/10 * * * *', 'select intern.fuhren_abgleichen()');

-- Ergebnis der Routine übernehmen (aufgerufen von fuhren-github mit service_role)
-- p_e: { stueck, gewicht_t, abladezeit "H:MM:SS", fahrer, begleitschein_nr, auftrag_nr, lieferschein_nr,
--        vertrag, ladestelle, datum, auffaellig, hinweise }
create or replace function public.fuhre_ergebnis_speichern(p_fuhre bigint, p_e jsonb, p_sha text)
returns void language plpgsql security definer set search_path = '' as $$
declare l bigint;
        f public.fuhren%rowtype;
        neu boolean := false;
begin
  select * into f from public.fuhren where id = p_fuhre;
  if not found then return; end if;
  if f.ergebnis_sha is not distinct from p_sha then return; end if;
  if nullif(btrim(p_e ->> 'vertrag'), '') is not null then
    select id into l from public.ladestellen where vertrag = btrim(p_e ->> 'vertrag');
    if l is null then
      insert into public.ladestellen (vertrag, name, angelegt_von)
      values (btrim(p_e ->> 'vertrag'), coalesce(nullif(btrim(p_e ->> 'ladestelle'), ''), 'Vertrag ' || btrim(p_e ->> 'vertrag')), 'Auslesen')
      returning id into l;
      neu := true;
    end if;
  end if;
  update public.fuhren set
    datum = coalesce(nullif(p_e ->> 'datum', '')::date, datum),
    ladestelle_id = coalesce(l, ladestelle_id),
    fahrer = coalesce(nullif(btrim(p_e ->> 'fahrer'), ''), fahrer),
    stueck = coalesce(nullif(p_e ->> 'stueck', '')::integer, stueck),
    gewicht_t = coalesce(nullif(p_e ->> 'gewicht_t', '')::numeric, gewicht_t),
    abladezeit = coalesce(nullif(p_e ->> 'abladezeit', '')::interval, abladezeit),
    begleitschein_nr = coalesce(nullif(btrim(p_e ->> 'begleitschein_nr'), ''), begleitschein_nr),
    auftrag_nr = coalesce(nullif(btrim(p_e ->> 'auftrag_nr'), ''), auftrag_nr),
    lieferschein_nr = coalesce(nullif(btrim(p_e ->> 'lieferschein_nr'), ''), lieferschein_nr),
    auffaellig = coalesce((p_e ->> 'auffaellig')::boolean, false) or neu,
    hinweise = nullif(concat_ws(' · ', nullif(btrim(p_e ->> 'hinweise'), ''),
                                case when neu then 'Neue Ladestelle (Vertrag ' || btrim(p_e ->> 'vertrag') || '): Preis fehlt noch' end), ''),
    ergebnis = p_e, ergebnis_sha = p_sha, ausgelesen_am = now()
  where id = p_fuhre;
  if coalesce((p_e ->> 'auffaellig')::boolean, false) or neu then
    perform intern.push_ausloesen(jsonb_build_array(jsonb_build_object(
      'titel', 'Fuhre prüfen',
      'text', 'Fuhre vom ' || to_char(f.datum, 'DD.MM.') || ': ' ||
              coalesce(nullif(btrim(p_e ->> 'hinweise'), ''), 'Neue Ladestelle, Preis fehlt noch'),
      'ziel', '#bahnschwellen/' || p_fuhre)));
  end if;
end $$;
revoke all on function public.fuhre_ergebnis_speichern(bigint, jsonb, text) from public, anon, authenticated;
grant execute on function public.fuhre_ergebnis_speichern(bigint, jsonb, text) to service_role;
