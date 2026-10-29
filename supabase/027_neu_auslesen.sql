-- 027: Fuhre neu auslesen, wenn nach der Weitergabe ein Scan dazukommt oder als falsch markiert wird (Christian, 29.10.2026).
-- Ablauf: Trigger auf belege merkt die Fuhre vor (neu_auslesen_ab). fuhren_abgleichen (jede Minute) wartet 3 Minuten Ruhe
-- (mehrere Seiten hintereinander = ein Durchgang) und bis das laufende Auslesen fertig ist, zählt dann auslese_runde hoch
-- und setzt die Weitergabe zurück. fuhren-github legt die Fuhre neu ab (alter Ordner und altes Ergebnis werden im selben
-- Commit entfernt), die Routine liest sie neu und schreibt den Hinweis neu. Ohne „drop“ geschrieben.

alter table public.fuhren add column if not exists neu_auslesen_ab timestamptz;
alter table public.fuhren add column if not exists auslese_runde integer not null default 1;

-- Spalten am Ende ergänzt, sonst wie 015
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
       f.neu_auslesen_ab, f.auslese_runde
  from public.fuhren f left join public.ladestellen l on l.id = f.ladestelle_id;

-- Neuer oder als falsch markierter Scan an einer schon weitergegebenen Fuhre → vormerken
create or replace function intern.fuhre_neu_vormerken()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (old.ungueltig_am is not distinct from new.ungueltig_am) then return null; end if;
  update public.fuhren set neu_auslesen_ab = now()
   where id = new.fuhre_id and quelle = 'app' and storniert_am is null and weitergegeben_am is not null;
  return null;
end $$;
revoke all on function intern.fuhre_neu_vormerken() from public, anon, authenticated;
create or replace trigger belege_neu_auslesen after insert or update of ungueltig_am on public.belege
  for each row execute function intern.fuhre_neu_vormerken();

create or replace function intern.fuhren_abgleichen()
returns void language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if not exists (select 1 from vault.secrets where name = 'github_gedaechtnis') then return; end if;
  -- Vorgemerkte Fuhren: 3 Minuten Ruhe und das letzte Auslesen fertig → Weitergabe zurücksetzen, nächste Runde
  update public.fuhren set weitergegeben_am = null, weitergabe_angestossen_am = null, weitergabe_fehler = null,
         auslese_runde = auslese_runde + 1, neu_auslesen_ab = null
   where neu_auslesen_ab < now() - interval '3 minutes' and storniert_am is null
     and weitergegeben_am is not null and ausgelesen_am >= weitergegeben_am;
  for r in select id from public.fuhren
            where quelle = 'app' and storniert_am is null and weitergegeben_am is null
              and (weitergabe_angestossen_am is null or weitergabe_angestossen_am < now() - interval '15 minutes') loop
    perform intern.fuhre_komplett_pruefen(r.id);
  end loop;
  -- Ergebnis abholen, solange eine Weitergabe noch nicht (neu) ausgelesen ist
  if exists (select 1 from public.fuhren where weitergegeben_am is not null and storniert_am is null
               and (ausgelesen_am is null or ausgelesen_am < weitergegeben_am)) then
    perform intern.fuhren_github_aufrufen(jsonb_build_object('aktion', 'abgleichen'));
  end if;
end $$;
revoke all on function intern.fuhren_abgleichen() from public, anon, authenticated;

-- Wie 016; beim Neu-Auslesen ersetzt der neue Hinweis den alten ganz (alles erledigt = kein Hinweis, grün).
-- Mitteilung an die Chefs nur, wenn der Hinweis neu ist (nicht bei gleichem Hinweis in der nächsten Runde).
create or replace function public.fuhre_ergebnis_speichern(p_fuhre bigint, p_e jsonb, p_sha text)
returns void language plpgsql security definer set search_path = '' as $$
declare l bigint;
        f public.fuhren%rowtype;
        neu boolean := false;
        doppelt text;
        auftrag text := nullif(btrim(p_e ->> 'auftrag_nr'), '');
        hinweis text;
        auff boolean;
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
  hinweis := nullif(concat_ws(' · ', nullif(btrim(p_e ->> 'hinweise'), ''),
                     case when neu then 'Neue Ladestelle (Vertrag ' || btrim(p_e ->> 'vertrag') || '): Preis fehlt noch' end,
                     case when doppelt is not null then 'Doppelt erfasst? Gleiche Auftragsnummer ' || auftrag || ' wie Fuhre ' || doppelt || ' – eine davon stornieren' end), '');
  auff := coalesce((p_e ->> 'auffaellig')::boolean, false) or neu or doppelt is not null;
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
    auffaellig = auff,
    hinweise = hinweis,
    ergebnis = p_e, ergebnis_sha = p_sha, ausgelesen_am = now()
  where id = p_fuhre;
  if auff and (f.ausgelesen_am is null or not f.auffaellig or hinweis is distinct from f.hinweise) then
    perform intern.push_ausloesen(jsonb_build_array(jsonb_build_object(
      'titel', 'Fuhre prüfen',
      'text', 'Fuhre vom ' || to_char(coalesce(nullif(p_e ->> 'datum', '')::date, f.datum), 'DD.MM.') || ': ' || coalesce(hinweis, 'bitte ansehen'),
      'ziel', '#bahnschwellen/' || p_fuhre)));
  end if;
end $$;
revoke all on function public.fuhre_ergebnis_speichern(bigint, jsonb, text) from public, anon, authenticated;
grant execute on function public.fuhre_ergebnis_speichern(bigint, jsonb, text) to service_role;
