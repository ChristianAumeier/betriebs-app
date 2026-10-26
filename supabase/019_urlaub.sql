-- 019: Urlaub und andere Abwesenheiten der Festangestellten (Christian, 26.10.2026)
-- Wochentag (Mo–Fr, kein Feiertag in Bayern) ohne Stempel → am nächsten Morgen automatisch ein Urlaubstag.
-- Nur für Personen mit personen.festangestellt (Minijobber arbeiten unregelmäßig) und erst ab personen.urlaub_ab.
-- Der Chef kann jeden Tag ändern (Urlaub / krank / frei) oder streichen; nichts wird gelöscht, nur storniert.
-- Gestrichene automatische Tage werden nicht neu angelegt. Kommt später ein Stempel für den Tag (Nachtrag),
-- wird der automatische Urlaub von selbst storniert.
-- Übersicht: Anspruch je Person und Jahr (urlaubsanspruch), genommen = gültige Urlaubstage, Rest.

alter table public.personen add column if not exists festangestellt boolean not null default false;
alter table public.personen add column if not exists urlaub_ab date;

create table if not exists public.abwesenheiten (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.personen(user_id),
  tag date not null,
  art text not null check (art in ('urlaub', 'krank', 'frei')),
  automatisch boolean not null default false,
  grund text,
  angelegt_am timestamptz not null default now(),
  angelegt_von uuid,
  storniert_am timestamptz,
  storniert_von uuid,
  storno_grund text
);
create unique index if not exists abwesenheiten_ein_eintrag_je_tag on public.abwesenheiten (user_id, tag) where storniert_am is null;

create table if not exists public.urlaubsanspruch (
  user_id uuid not null references public.personen(user_id),
  jahr int not null,
  tage numeric not null check (tage >= 0 and tage <= 60),
  geaendert_am timestamptz not null default now(),
  geaendert_von uuid,
  primary key (user_id, jahr)
);

do $$
declare t text;
begin
  foreach t in array array['abwesenheiten', 'urlaubsanspruch'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'Eigene oder Chef') then
      execute format('create policy "Eigene oder Chef" on public.%I for select to authenticated using (((auth.jwt() ->> ''aal'') = ''aal2'') and (user_id = auth.uid() or public.ist_chef()))', t);
    end if;
  end loop;
end $$;

-- Gesetzliche Feiertage in Bayern (mit Mariä Himmelfahrt, gilt in Schierling); Name oder null
create or replace function public.feiertag_bayern(d date)
returns text language plpgsql immutable set search_path = '' as $$
declare
  j int := extract(year from d);
  a int; b int; c int; k int; e int; f int; g int; h int; i int; l int; m int;
  ostern date;
begin
  -- Ostersonntag (gregorianisch, Meeus/Jones/Butcher)
  a := j % 19; b := j / 100; c := j % 100; k := b / 4; e := b % 4;
  f := (b + 8) / 25; g := (b - f + 1) / 3; h := (19 * a + b - k - g + 15) % 30;
  i := c / 4; l := (32 + 2 * e + 2 * i - h - c % 4) % 7; m := (a + 11 * h + 22 * l) / 451;
  ostern := make_date(j, (h + l - 7 * m + 114) / 31, ((h + l - 7 * m + 114) % 31) + 1);
  return case
    when to_char(d, 'MM-DD') = '01-01' then 'Neujahr'
    when to_char(d, 'MM-DD') = '01-06' then 'Heilige Drei Könige'
    when d = ostern - 2 then 'Karfreitag'
    when d = ostern + 1 then 'Ostermontag'
    when to_char(d, 'MM-DD') = '05-01' then 'Tag der Arbeit'
    when d = ostern + 39 then 'Christi Himmelfahrt'
    when d = ostern + 50 then 'Pfingstmontag'
    when d = ostern + 60 then 'Fronleichnam'
    when to_char(d, 'MM-DD') = '08-15' then 'Mariä Himmelfahrt'
    when to_char(d, 'MM-DD') = '10-03' then 'Tag der Deutschen Einheit'
    when to_char(d, 'MM-DD') = '11-01' then 'Allerheiligen'
    when to_char(d, 'MM-DD') = '12-25' then '1. Weihnachtstag'
    when to_char(d, 'MM-DD') = '12-26' then '2. Weihnachtstag'
  end;
end $$;
grant execute on function public.feiertag_bayern(date) to authenticated;

-- Täglich: fehlende Tage als Urlaub eintragen, überholte automatische Urlaubstage stornieren
create or replace function intern.urlaub_eintragen()
returns void language plpgsql security definer set search_path = '' as $$
declare gestern date := (now() at time zone 'Europe/Berlin')::date - 1;
begin
  -- Stempel nachträglich da (gültig oder wartend) → automatischen Urlaub stornieren
  update public.abwesenheiten a
     set storniert_am = now(), storno_grund = 'Für den Tag gibt es jetzt Stempel'
   where a.automatisch and a.storniert_am is null
     and exists (select 1 from public.stempel s where s.user_id = a.user_id and s.status <> 'abgelehnt'
                    and (s.zeit at time zone 'Europe/Berlin')::date = a.tag);

  insert into public.abwesenheiten (user_id, tag, art, automatisch, grund)
  select p.user_id, d::date, 'urlaub', true, 'Wochentag ohne Stempel'
    from public.personen p
    cross join lateral generate_series(greatest(p.urlaub_ab, gestern - 31), gestern, interval '1 day') d
   where p.festangestellt and p.stempelt and p.urlaub_ab is not null
     and extract(isodow from d) <= 5
     and public.feiertag_bayern(d::date) is null
     and not exists (select 1 from public.stempel s where s.user_id = p.user_id and s.status <> 'abgelehnt'
                        and (s.zeit at time zone 'Europe/Berlin')::date = d::date)
     -- irgendein Eintrag für den Tag (auch ein gestrichener) → nichts automatisch anlegen
     and not exists (select 1 from public.abwesenheiten a where a.user_id = p.user_id and a.tag = d::date);
end $$;
revoke all on function intern.urlaub_eintragen() from public, anon, authenticated;

-- Chef: Tag setzen (urlaub/krank/frei) oder mit p_art = null streichen
create or replace function public.abwesenheit_setzen(p_user uuid, p_tag date, p_art text, p_grund text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.ist_chef() then raise exception 'Dafür fehlt die Berechtigung' using errcode = '42501'; end if;
  if p_art is not null and p_art not in ('urlaub', 'krank', 'frei') then
    raise exception 'Unbekannte Art: %', p_art using errcode = '22023';
  end if;
  if not exists (select 1 from public.personen where user_id = p_user) then
    raise exception 'Person nicht gefunden' using errcode = '22023';
  end if;
  update public.abwesenheiten set storniert_am = now(), storniert_von = auth.uid(),
         storno_grund = coalesce(nullif(btrim(p_grund), ''), case when p_art is null then 'gestrichen' else 'geändert' end)
   where user_id = p_user and tag = p_tag and storniert_am is null;
  if p_art is not null then
    insert into public.abwesenheiten (user_id, tag, art, automatisch, grund, angelegt_von)
    values (p_user, p_tag, p_art, false, nullif(btrim(p_grund), ''), auth.uid());
  end if;
end $$;

-- Chef: Urlaubsanspruch für ein Jahr
create or replace function public.urlaubsanspruch_setzen(p_user uuid, p_jahr int, p_tage numeric)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.ist_chef() then raise exception 'Dafür fehlt die Berechtigung' using errcode = '42501'; end if;
  insert into public.urlaubsanspruch (user_id, jahr, tage, geaendert_von) values (p_user, p_jahr, p_tage, auth.uid())
  on conflict (user_id, jahr) do update set tage = excluded.tage, geaendert_am = now(), geaendert_von = auth.uid();
end $$;

-- Chef: festangestellt an/aus; beim Einschalten zählen Tage erst ab morgen
create or replace function public.person_festangestellt_setzen(p_user uuid, p_an boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.ist_chef() then raise exception 'Dafür fehlt die Berechtigung' using errcode = '42501'; end if;
  update public.personen
     set festangestellt = p_an,
         urlaub_ab = case when p_an and not festangestellt then (now() at time zone 'Europe/Berlin')::date + 1 else urlaub_ab end
   where user_id = p_user;
  if not found then raise exception 'Person nicht gefunden' using errcode = '22023'; end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.abwesenheit_setzen(uuid, date, text, text)', 'public.urlaubsanspruch_setzen(uuid, int, numeric)',
                           'public.person_festangestellt_setzen(uuid, boolean)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to authenticated';
  end loop;
end $$;

-- 04:30 UTC = 05:30 / 06:30 deutsche Zeit
select cron.schedule('urlaub_eintragen', '30 4 * * *', 'select intern.urlaub_eintragen()');
