-- 029: Meldungen je Fuhre einzeln (Christian, 29.10.2026): „nicht mehrere verschiedene Fehler in eine Meldung; jede
-- einzeln auf erledigt/grün setzen“. Tabelle fuhre_hinweise = eine Zeile je Fehler. Die Fuhre ist auffällig (rot),
-- solange eine Meldung offen ist; fuhren.hinweise enthält die offenen Meldungen zusammengefügt (für Liste, CSV, Push).
-- Beim Neu-Auslesen (027) werden die offenen Meldungen der alten Runde durch die neuen ersetzt (ersetzt_am);
-- vom Chef Erledigtes bleibt erledigt, gleicher Text kommt nicht wieder als offen. Nie löschen. Ohne „drop“ geschrieben.

create table if not exists public.fuhre_hinweise (
  id bigint generated always as identity primary key,
  fuhre_id bigint not null references public.fuhren(id),
  text text not null,
  runde integer not null default 1,
  quelle text not null default 'auslesen' check (quelle in ('auslesen', 'app')),
  angelegt_am timestamptz not null default now(),
  erledigt_am timestamptz,
  erledigt_von text,
  ersetzt_am timestamptz              -- durch Neu-Auslesen überholt (nicht mehr zeigen)
);
create index if not exists fuhre_hinweise_fuhre on public.fuhre_hinweise (fuhre_id, id);
alter table public.fuhre_hinweise enable row level security;
revoke all on public.fuhre_hinweise from public, anon, authenticated;
grant select on public.fuhre_hinweise to authenticated;
grant select on public.fuhre_hinweise to service_role;
create policy "Fuhren-Berechtigte" on public.fuhre_hinweise for select to authenticated using (public.fuhren_rolle() is not null);

-- auffaellig und hinweise der Fuhre aus den offenen Meldungen
create or replace function intern.fuhre_hinweise_auffrischen(p_fuhre bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.fuhren f set
    auffaellig = exists (select 1 from public.fuhre_hinweise h where h.fuhre_id = f.id and h.erledigt_am is null and h.ersetzt_am is null),
    hinweise = (select string_agg(h.text, ' · ' order by h.id) from public.fuhre_hinweise h
                 where h.fuhre_id = f.id and h.erledigt_am is null and h.ersetzt_am is null)
  where f.id = p_fuhre;
end $$;
revoke all on function intern.fuhre_hinweise_auffrischen(bigint) from public, anon, authenticated;

-- Neue Meldung (offen); war derselbe Text für diese Fuhre schon erledigt, gleich als erledigt eintragen
create or replace function intern.fuhre_hinweis_dazu(p_fuhre bigint, p_text text, p_runde integer, p_quelle text)
returns void language plpgsql security definer set search_path = '' as $$
declare t text := nullif(btrim(p_text), '');
        alt public.fuhre_hinweise%rowtype;
begin
  if t is null then return; end if;
  select * into alt from public.fuhre_hinweise where fuhre_id = p_fuhre and erledigt_am is not null and lower(text) = lower(t) order by id desc limit 1;
  insert into public.fuhre_hinweise (fuhre_id, text, runde, quelle, erledigt_am, erledigt_von)
  values (p_fuhre, t, p_runde, p_quelle, alt.erledigt_am, alt.erledigt_von);
end $$;
revoke all on function intern.fuhre_hinweis_dazu(bigint, text, integer, text) from public, anon, authenticated;

-- Chef: eine Meldung erledigt
create or replace function public.fuhre_hinweis_erledigt(p_hinweis bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare f bigint;
begin
  if not public.ist_chef() then raise exception 'Nur für Christian und Carolin' using errcode = '42501'; end if;
  update public.fuhre_hinweise set erledigt_am = now(), erledigt_von = auth.jwt() ->> 'email'
   where id = p_hinweis and erledigt_am is null and ersetzt_am is null
  returning fuhre_id into f;
  if f is null then raise exception 'Meldung nicht gefunden oder schon erledigt' using errcode = '22023'; end if;
  perform intern.fuhre_hinweise_auffrischen(f);
end $$;
revoke all on function public.fuhre_hinweis_erledigt(bigint) from public, anon, authenticated;
grant execute on function public.fuhre_hinweis_erledigt(bigint) to authenticated;

-- Spalte am Ende ergänzt, sonst wie 027
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
       exists (select 1 from public.belege b where b.fuhre_id = f.id and b.ungueltig_am is null and b.art = 'altscan') as hat_altscan,
       f.abgeschlossen_am, f.abgeschlossen_von, f.abschluss_grund,
       f.neu_auslesen_ab, f.auslese_runde,
       (select count(*) from public.fuhre_hinweise h where h.fuhre_id = f.id and h.erledigt_am is null and h.ersetzt_am is null)::integer as offene_hinweise
  from public.fuhren f left join public.ladestellen l on l.id = f.ladestelle_id;

-- Wie 027, aber „hinweise“ darf eine Liste sein (eine Meldung je Eintrag; Text = eine Meldung).
-- Offene Meldungen der Fuhre werden ersetzt; auffällig = mindestens eine offene Meldung.
create or replace function public.fuhre_ergebnis_speichern(p_fuhre bigint, p_e jsonb, p_sha text)
returns void language plpgsql security definer set search_path = '' as $$
declare l bigint;
        f public.fuhren%rowtype;
        neu boolean := false;
        doppelt text;
        auftrag text := nullif(btrim(p_e ->> 'auftrag_nr'), '');
        texte text[];
        t text;
        vorher text[];
        nachher text[];
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
  if auftrag is not null then
    select string_agg(x.id::text, ', ' order by x.id) into doppelt
      from public.fuhren x where x.id <> p_fuhre and x.storniert_am is null and x.auftrag_nr = auftrag;
  end if;
  -- Meldungen: Liste oder (alte Form) ein Text; ein Text ohne „auffaellig“ gilt als Info und wird keine Meldung
  if jsonb_typeof(p_e -> 'hinweise') = 'array' then
    select coalesce(array_agg(x), '{}') into texte from jsonb_array_elements_text(p_e -> 'hinweise') x where btrim(x) <> '';
  elsif coalesce((p_e ->> 'auffaellig')::boolean, false) and nullif(btrim(p_e ->> 'hinweise'), '') is not null then
    texte := array[btrim(p_e ->> 'hinweise')];
  else
    texte := '{}';
  end if;
  if coalesce((p_e ->> 'auffaellig')::boolean, false) and cardinality(texte) = 0 then texte := array['Beim Auslesen als auffällig markiert (ohne Begründung).']; end if;
  if neu then texte := texte || ('Neue Ladestelle (Vertrag ' || btrim(p_e ->> 'vertrag') || '): Preis fehlt noch'); end if;
  if doppelt is not null then texte := texte || ('Doppelt erfasst? Gleiche Auftragsnummer ' || auftrag || ' wie Fuhre ' || doppelt || ' – eine davon stornieren'); end if;

  select coalesce(array_agg(text order by id), '{}') into vorher from public.fuhre_hinweise
   where fuhre_id = p_fuhre and erledigt_am is null and ersetzt_am is null;
  update public.fuhre_hinweise set ersetzt_am = now() where fuhre_id = p_fuhre and erledigt_am is null and ersetzt_am is null;
  foreach t in array texte loop
    perform intern.fuhre_hinweis_dazu(p_fuhre, t, f.auslese_runde, 'auslesen');
  end loop;

  update public.fuhren set
    datum = coalesce(nullif(p_e ->> 'datum', '')::date, datum),
    ladestelle_id = coalesce(l, ladestelle_id),
    fahrer = coalesce(nullif(btrim(p_e ->> 'fahrer'), ''), fahrer),
    stueck = coalesce(nullif(p_e ->> 'stueck', '')::integer, stueck),
    gewicht_t = coalesce(nullif(p_e ->> 'gewicht_t', '')::numeric, gewicht_t),
    abladezeit = coalesce(nullif(p_e ->> 'abladezeit', '')::interval, abladezeit),
    begleitschein_nr = coalesce(nullif(btrim(p_e ->> 'begleitschein_nr'), ''), begleitschein_nr),
    auftrag_nr = coalesce(auftrag, auftrag_nr),
    lieferschein_nr = coalesce(nullif(btrim(p_e ->> 'lieferschein_nr'), ''), lieferschein_nr),
    ergebnis = p_e, ergebnis_sha = p_sha, ausgelesen_am = now()
  where id = p_fuhre;
  perform intern.fuhre_hinweise_auffrischen(p_fuhre);

  -- Mitteilung an die Chefs nur, wenn eine neue offene Meldung dazukam
  select coalesce(array_agg(text order by id), '{}') into nachher from public.fuhre_hinweise
   where fuhre_id = p_fuhre and erledigt_am is null and ersetzt_am is null;
  if exists (select 1 from unnest(nachher) n where not (n = any (vorher))) then
    perform intern.push_ausloesen(jsonb_build_array(jsonb_build_object(
      'titel', 'Fuhre prüfen',
      'text', 'Fuhre vom ' || to_char(coalesce(nullif(p_e ->> 'datum', '')::date, f.datum), 'DD.MM.') || ': ' || array_to_string(nachher, ' · '),
      'ziel', '#bahnschwellen/' || p_fuhre)));
  end if;
end $$;
revoke all on function public.fuhre_ergebnis_speichern(bigint, jsonb, text) from public, anon, authenticated;
grant execute on function public.fuhre_ergebnis_speichern(bigint, jsonb, text) to service_role;
