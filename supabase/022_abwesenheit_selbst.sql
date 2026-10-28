-- 022: Mitarbeiter tragen Urlaub, Frei und Krank selbst ein (Christian, 28.10.2026)
-- Wer ein Überstundenkonto hat, bekommt keinen automatischen Urlaub mehr: Ein Werktag ohne Stempel bleibt „offen“
-- (zählt als nicht gearbeitet), bis der Mitarbeiter wählt. Die App fragt beim nächsten Start nach
-- (gearbeitet = Nachtrag, Frei, Urlaub, Krank). Vorab (z. B. Urlaub nächste Woche) geht es ebenso.
-- Ohne Überstundenkonto (Festgehalt, Jürgen Ungefug) bleibt der automatische Urlaub aus 019.
-- Zeitraum für den Mitarbeiter: ab Monatsanfang, bis zum 5. auch der Vormonat; nach vorn bis ein Jahr.
-- Einträge vom Chef darf der Mitarbeiter nicht ändern; der Chef kann alles (abwesenheit_setzen).

-- Frühester Tag, den ein Mitarbeiter selbst ändern darf (gleich in stempeln.js, selbstAb())
create or replace function public.abwesenheit_selbst_ab()
returns date language sql stable set search_path = '' as $$
  select case when extract(day from (now() at time zone 'Europe/Berlin')) <= 5
              then (date_trunc('month', (now() at time zone 'Europe/Berlin')) - interval '1 month')::date
              else date_trunc('month', (now() at time zone 'Europe/Berlin'))::date end;
$$;
grant execute on function public.abwesenheit_selbst_ab() to authenticated;

-- Mitarbeiter: Tage von–bis als Urlaub/Frei/Krank eintragen, mit p_art = null eigene Einträge streichen.
-- Wochenenden, Feiertage, Tage mit Stempel (gültig oder wartend) und Einträge vom Chef werden übersprungen.
-- Rückgabe: Zahl der geänderten Tage.
create or replace function public.abwesenheit_selbst(p_von date, p_bis date, p_art text)
returns int language plpgsql security definer set search_path = '' as $$
declare
  heute date := (now() at time zone 'Europe/Berlin')::date;
  frueh date := public.abwesenheit_selbst_ab();
  p record;
  d date;
  alt record;
  n int := 0;
begin
  if auth.uid() is null or (auth.jwt() ->> 'aal') is distinct from 'aal2' then
    raise exception 'Nur nach Anmeldung mit Code' using errcode = '42501';
  end if;
  select pe.*, ks.stichtag into p from public.personen pe left join public.konto_start ks on ks.user_id = pe.user_id
   where pe.user_id = auth.uid() and pe.stempelt and pe.festangestellt;
  if not found then raise exception 'Für dieses Konto gibt es keinen Urlaub' using errcode = '42501'; end if;
  if p_art is not null and p_art not in ('urlaub', 'krank', 'frei') then
    raise exception 'Unbekannte Art: %', p_art using errcode = '22023';
  end if;
  if p_von is null or p_bis is null or p_bis < p_von then
    raise exception 'Bitte Tage von–bis angeben' using errcode = '22023';
  end if;
  frueh := greatest(frueh, p.urlaub_ab, p.stichtag + 1);
  if p_von < frueh then
    raise exception 'Tage vor dem % kann nur Christian ändern', to_char(frueh, 'DD.MM.YYYY') using errcode = '22023';
  end if;
  if p_bis > heute + 366 or p_bis - p_von > 62 then
    raise exception 'Höchstens ein Jahr voraus und höchstens zwei Monate am Stück' using errcode = '22023';
  end if;

  for d in select g::date from generate_series(p_von, p_bis, interval '1 day') g loop
    continue when extract(isodow from d) > 5 or public.feiertag_bayern(d) is not null;
    select * into alt from public.abwesenheiten a where a.user_id = auth.uid() and a.tag = d and a.storniert_am is null;
    -- Eintrag vom Chef bleibt
    continue when found and not alt.automatisch and alt.angelegt_von is distinct from auth.uid();
    if p_art is null then
      continue when alt.id is null;
    else
      continue when found and alt.art = p_art;
      continue when exists (select 1 from public.stempel s where s.user_id = auth.uid() and s.status <> 'abgelehnt'
                               and (s.zeit at time zone 'Europe/Berlin')::date = d);
    end if;
    update public.abwesenheiten set storniert_am = now(), storniert_von = auth.uid(),
           storno_grund = case when p_art is null then 'vom Mitarbeiter gestrichen' else 'vom Mitarbeiter geändert' end
     where user_id = auth.uid() and tag = d and storniert_am is null;
    if p_art is not null then
      insert into public.abwesenheiten (user_id, tag, art, automatisch, grund, angelegt_von)
      values (auth.uid(), d, p_art, false, 'vom Mitarbeiter eingetragen', auth.uid());
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.abwesenheit_selbst(date, date, text) from public, anon, authenticated;
grant execute on function public.abwesenheit_selbst(date, date, text) to authenticated;

-- Automatischer Urlaub nur noch ohne Überstundenkonto
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
   where p.festangestellt and p.stempelt and p.urlaub_ab is not null and not p.ueberstundenkonto
     and extract(isodow from d) <= 5
     and public.feiertag_bayern(d::date) is null
     and not exists (select 1 from public.stempel s where s.user_id = p.user_id and s.status <> 'abgelehnt'
                        and (s.zeit at time zone 'Europe/Berlin')::date = d::date)
     -- irgendein Eintrag für den Tag (auch ein gestrichener) → nichts automatisch anlegen
     and not exists (select 1 from public.abwesenheiten a where a.user_id = p.user_id and a.tag = d::date);
end $$;
revoke all on function intern.urlaub_eintragen() from public, anon, authenticated;
