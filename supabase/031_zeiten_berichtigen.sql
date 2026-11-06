-- 031: Chef berichtigt die Zeiten eines Tages direkt (Christian, 06.11.2026: „Wenn ich was ändere,
-- einfach ändern und keinen Fehler melden“).
-- Bisher kam jede Berichtigung über stempel_nachtragen als ZUSÄTZLICHER Stempel dazu, der alte blieb gültig.
-- Beispiel Damian 06.11.: echter Start 08:24 + berichtigter Start 07:50 = zweimal Start → „Stopp fehlt“,
-- und gezählt wurde ab dem letzten Start.
-- Jetzt in einem Schritt: ersetzte oder gestrichene Stempel werden abgelehnt (nichts gelöscht, wer/wann bleibt),
-- wartende Nachträge, die stehen bleiben, werden freigegeben, neue Zeiten kommen gültig dazu.
-- Danach muss die Reihenfolge des Tages stimmen (Start → Pause → Pause beenden → Stopp), sonst wird nichts gespeichert.
-- Ohne „drop“ geschrieben (siehe Lehre in CLAUDE.md).

create or replace function public.zeiten_berichtigen(
  p_user uuid, p_tag date, p_weg bigint[], p_frei bigint[], p_neu jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  tag_von timestamptz := (p_tag::timestamp) at time zone 'Europe/Berlin';
  tag_bis timestamptz := ((p_tag + 1)::timestamp) at time zone 'Europe/Berlin';
  e jsonb; t timestamptz; n int; z text; s record; erster boolean := true;
begin
  if not public.ist_chef() then raise exception 'Nur für Christian und Carolin' using errcode = '42501'; end if;
  if not exists (select 1 from public.personen where user_id = p_user) then
    raise exception 'Person nicht gefunden' using errcode = '22023';
  end if;

  -- ersetzte oder gestrichene Stempel ablehnen (nur dieser Person, nur an diesem Tag)
  if coalesce(cardinality(p_weg), 0) > 0 then
    update public.stempel set status = 'abgelehnt', entschieden_am = now(), entschieden_von = auth.uid()
     where id = any(p_weg) and user_id = p_user and status <> 'abgelehnt' and zeit >= tag_von and zeit < tag_bis;
    get diagnostics n = row_count;
    if n <> (select count(distinct x) from unnest(p_weg) x) then
      raise exception 'Die Zeiten haben sich inzwischen geändert. Bitte neu öffnen.' using errcode = '22023';
    end if;
  end if;

  -- wartende Nachträge, die stehen bleiben: freigeben
  if coalesce(cardinality(p_frei), 0) > 0 then
    update public.stempel set status = 'gueltig', entschieden_am = now(), entschieden_von = auth.uid()
     where id = any(p_frei) and user_id = p_user and status = 'offen' and zeit >= tag_von and zeit < tag_bis;
    get diagnostics n = row_count;
    if n <> (select count(distinct x) from unnest(p_frei) x) then
      raise exception 'Die Zeiten haben sich inzwischen geändert. Bitte neu öffnen.' using errcode = '22023';
    end if;
  end if;

  -- neue Zeiten: gelten sofort
  for e in select * from jsonb_array_elements(coalesce(p_neu, '[]'::jsonb)) loop
    if coalesce(e ->> 'art', '') not in ('start', 'pause', 'weiter', 'stopp') then
      raise exception 'Unbekannte Art: %', e ->> 'art' using errcode = '22023';
    end if;
    t := (e ->> 'zeit')::timestamptz;
    if t is null or t < tag_von or t >= tag_bis then
      raise exception 'Die Zeit gehört nicht zum %', to_char(p_tag, 'DD.MM.YYYY') using errcode = '22023';
    end if;
    if t > now() + interval '1 minute' then
      raise exception 'Die Zeit liegt in der Zukunft' using errcode = '22023';
    end if;
    insert into public.stempel (user_id, art, zeit, nachtrag, grund, status, angelegt_von, entschieden_am, entschieden_von)
    values (p_user, e ->> 'art', t, true, 'vom Chef berichtigt', 'gueltig', auth.uid(), now(), auth.uid());
  end loop;

  -- Reihenfolge des Tages prüfen (gültige und wartende Stempel, wie beim Zustand).
  -- Ausgangszustand = letzter Stempel davor; ein „Start“ als erster Stempel des Tages ist immer erlaubt
  -- (sonst würde ein vergessener Stopp vom Vortag jede Berichtigung sperren).
  z := case coalesce((select s2.art from public.stempel s2
                       where s2.user_id = p_user and s2.status <> 'abgelehnt' and s2.zeit < tag_von
                       order by s2.zeit desc, s2.id desc limit 1), 'stopp')
         when 'stopp' then 'aus' when 'pause' then 'pause' else 'arbeitet' end;
  for s in select st.art, st.zeit from public.stempel st
            where st.user_id = p_user and st.status <> 'abgelehnt' and st.zeit >= tag_von and st.zeit < tag_bis
            order by st.zeit, st.id loop
    if not ((s.art = 'start' and (z = 'aus' or erster))
         or (s.art = 'pause' and z = 'arbeitet')
         or (s.art = 'weiter' and z = 'pause')
         or (s.art = 'stopp' and z <> 'aus')) then
      raise exception 'Die Reihenfolge stimmt nicht: „%“ um % passt hier nicht. Nichts gespeichert.',
        case s.art when 'start' then 'Start' when 'pause' then 'Pause' when 'weiter' then 'Pause beenden' else 'Stopp' end,
        to_char(s.zeit at time zone 'Europe/Berlin', 'HH24:MI') using errcode = '22023';
    end if;
    z := case s.art when 'stopp' then 'aus' when 'pause' then 'pause' else 'arbeitet' end;
    erster := false;
  end loop;
end $$;

revoke all on function public.zeiten_berichtigen(uuid, date, bigint[], bigint[], jsonb) from public, anon, authenticated;
grant execute on function public.zeiten_berichtigen(uuid, date, bigint[], bigint[], jsonb) to authenticated;
