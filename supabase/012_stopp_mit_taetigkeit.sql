-- 012: Stopp nur, wenn für den Arbeitstag eingetragen ist, was gemacht wurde (Christians Wunsch).
-- Arbeitstag = Tag (deutsche Zeit), an dem die laufende Schicht mit Start begann.
-- Nachträge (stempel_nachtragen) prüft das nicht; die App fragt beim Nachtragen eines Stopps trotzdem danach.
create or replace function public.stempeln(p_art text)
returns void language plpgsql security definer set search_path = '' as $$
declare z text;
        schicht date;
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
  if p_art = 'stopp' then
    select (s.zeit at time zone 'Europe/Berlin')::date into schicht from public.stempel s
     where s.user_id = auth.uid() and s.art = 'start' and s.status <> 'abgelehnt' and s.zeit <= now()
     order by s.zeit desc, s.id desc limit 1;
    if not exists (select 1 from public.taetigkeiten t where t.user_id = auth.uid() and t.tag = schicht) then
      raise exception 'Bitte zuerst eintragen, was du heute gemacht hast' using errcode = '22023';
    end if;
  end if;
  insert into public.stempel (user_id, art, zeit, angelegt_von) values (auth.uid(), p_art, now(), auth.uid());
end $$;
