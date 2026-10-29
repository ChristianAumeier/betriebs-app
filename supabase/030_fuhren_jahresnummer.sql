-- 030: Fuhren-Nummer je Jahr (Christian, 29.10.2026): sichtbare Nummer, ab 1. Januar wieder bei 1.
-- Die Nummer vergibt die Datenbank beim ERSTEN Scan der Fuhre (Jahr = Jahr des Ladetags zu dem Zeitpunkt), lückenlos:
-- leer angelegte Fuhren bekommen keine Nummer und können gelöscht werden (026), ohne eine Lücke zu reißen.
-- Stornierte Fuhren behalten ihre Nummer. Ändert sich der Ladetag später ins Nachbarjahr, bleibt die Nummer.
-- Bestand: alle Fuhren mit Scans nach Ladetag (dann id) durchnummeriert. Ohne „drop“ geschrieben.

alter table public.fuhren add column if not exists jahr integer;
alter table public.fuhren add column if not exists nr integer;
create unique index if not exists fuhren_jahr_nr on public.fuhren (jahr, nr);

create table if not exists intern.fuhren_nummernkreis (jahr integer primary key, letzte integer not null);
revoke all on intern.fuhren_nummernkreis from public, anon, authenticated;

create or replace function intern.fuhre_nummer_vergeben(p_fuhre bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare j integer;
        n integer;
begin
  select extract(year from datum)::integer into j from public.fuhren where id = p_fuhre and nr is null for update;
  if j is null then return; end if;
  insert into intern.fuhren_nummernkreis as k (jahr, letzte) values (j, 1)
  on conflict (jahr) do update set letzte = k.letzte + 1
  returning letzte into n;
  update public.fuhren set jahr = j, nr = n where id = p_fuhre;
end $$;
revoke all on function intern.fuhre_nummer_vergeben(bigint) from public, anon, authenticated;

create or replace function intern.fuhre_nummer_beim_scan()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform intern.fuhre_nummer_vergeben(new.fuhre_id);
  return null;
end $$;
revoke all on function intern.fuhre_nummer_beim_scan() from public, anon, authenticated;
create or replace trigger belege_nummer_vergeben after insert on public.belege
  for each row execute function intern.fuhre_nummer_beim_scan();

-- Bestand nummerieren
with n as (
  select f.id, extract(year from f.datum)::integer as j,
         row_number() over (partition by extract(year from f.datum) order by f.datum, f.id) as nr
    from public.fuhren f
   where f.nr is null and exists (select 1 from public.belege b where b.fuhre_id = f.id)
)
update public.fuhren f set jahr = n.j, nr = n.nr from n where f.id = n.id;
insert into intern.fuhren_nummernkreis (jahr, letzte)
select jahr, max(nr) from public.fuhren where nr is not null group by jahr
on conflict (jahr) do update set letzte = greatest(intern.fuhren_nummernkreis.letzte, excluded.letzte);

-- Spalten am Ende ergänzt, sonst wie 029
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
       (select count(*) from public.fuhre_hinweise h where h.fuhre_id = f.id and h.erledigt_am is null and h.ersetzt_am is null)::integer as offene_hinweise,
       f.jahr, f.nr
  from public.fuhren f left join public.ladestellen l on l.id = f.ladestelle_id;

-- Wie 029, aber Meldung „Doppelt erfasst?“ und Mitteilung nennen die Fuhren-Nummer statt der internen Kennung
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
    select string_agg(coalesce('Nr. ' || x.nr || coalesce('/' || x.jahr, ''), 'ohne Nummer'), ', ' order by x.jahr, x.nr) into doppelt
      from public.fuhren x where x.id <> p_fuhre and x.storniert_am is null and x.auftrag_nr = auftrag;
  end if;
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

  select coalesce(array_agg(text order by id), '{}') into nachher from public.fuhre_hinweise
   where fuhre_id = p_fuhre and erledigt_am is null and ersetzt_am is null;
  if exists (select 1 from unnest(nachher) n where not (n = any (vorher))) then
    perform intern.push_ausloesen(jsonb_build_array(jsonb_build_object(
      'titel', 'Fuhre prüfen',
      'text', 'Fuhre ' || coalesce('Nr. ' || f.nr || ' ', '') || 'vom ' || to_char(coalesce(nullif(p_e ->> 'datum', '')::date, f.datum), 'DD.MM.') || ': ' || array_to_string(nachher, ' · '),
      'ziel', '#bahnschwellen/' || p_fuhre)));
  end if;
end $$;
revoke all on function public.fuhre_ergebnis_speichern(bigint, jsonb, text) from public, anon, authenticated;
grant execute on function public.fuhre_ergebnis_speichern(bigint, jsonb, text) to service_role;
