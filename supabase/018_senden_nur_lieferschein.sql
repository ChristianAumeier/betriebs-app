-- 018: An die Transportfirma senden geht schon mit dem Lieferschein allein (Christian, 26.10.2026).
-- Den Begleitschein kann der Fahrer scannen oder die Transportfirma dranhängen (wie den Registerbeleg).
-- Komplett bleibt: Lieferschein + Wiegeschein + (Begleitschein oder abgeschlossen), egal wer ihn abgelegt hat.

create or replace function public.fuhre_absenden(p_fuhre bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare f public.fuhren_liste%rowtype;
begin
  perform intern.fuhren_pruefen_rolle(array['chef', 'fahrer']);
  select * into f from public.fuhren_liste where id = p_fuhre;
  if not found or f.storniert_am is not null then raise exception 'Fuhre nicht gefunden oder storniert' using errcode = '22023'; end if;
  if not f.hat_lieferschein then
    raise exception 'Bitte zuerst den Lieferschein scannen' using errcode = '22023';
  end if;
  if f.abgesendet_am is not null then return; end if;
  update public.fuhren set abgesendet_am = now() where id = p_fuhre;
  perform intern.push_an(jsonb_build_array(jsonb_build_object(
    'titel', 'Neue Fuhre – bitte signieren',
    'text', f.lkw || ' · ' || to_char(f.datum, 'DD.MM.YYYY') || coalesce(' · ' || f.ladestelle, '') || coalesce(' · ' || f.fahrer, ''),
    'ziel', '#bahnschwellen/' || p_fuhre)),
    (select coalesce(array_agg(p.user_id), '{}') from public.personen p where p.fuhren = 'transportfirma'));
end $$;

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
  if r = 'transportfirma' and p_art not in ('registerbeleg', 'begleitschein') then
    raise exception 'Die Transportfirma legt nur Begleitschein und Registerbeleg ab' using errcode = '42501';
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

-- Hochladen: Chef und Fahrer alle Arten, Transportfirma Begleitschein und Registerbeleg
alter policy "Belege hochladen" on storage.objects
  with check (bucket_id = 'belege' and split_part(name, '/', 1) = 'fuhren'
              and (public.fuhren_rolle() in ('chef', 'fahrer')
                   or (public.fuhren_rolle() = 'transportfirma'
                       and (split_part(name, '/', 3) like 'registerbeleg-%' or split_part(name, '/', 3) like 'begleitschein-%'))));
