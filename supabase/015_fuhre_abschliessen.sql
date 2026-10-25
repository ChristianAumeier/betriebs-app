-- 015: Fuhre trotz fehlender Belege abschließen (z. B. KW 43: Begleitschein und Registerbeleg nicht mehr vorhanden).
-- Nur Chef, mit Grund. Lieferschein und Wiegeschein müssen da sein (daraus wird ausgelesen).
-- Abgeschlossen zählt wie komplett: die Fuhre geht zum Auslesen. Ohne „drop“ geschrieben.

alter table public.fuhren add column if not exists abgeschlossen_am timestamptz;
alter table public.fuhren add column if not exists abgeschlossen_von text;
alter table public.fuhren add column if not exists abschluss_grund text;

-- Ansicht um die neuen Spalten ergänzen (nur hinten angehängt)
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
       f.abgeschlossen_am, f.abgeschlossen_von, f.abschluss_grund
  from public.fuhren f left join public.ladestellen l on l.id = f.ladestelle_id;

create or replace function public.fuhre_abschliessen(p_fuhre bigint, p_grund text)
returns void language plpgsql security definer set search_path = '' as $$
declare f public.fuhren_liste%rowtype;
begin
  if not public.ist_chef() then raise exception 'Nur für Christian und Carolin' using errcode = '42501'; end if;
  if coalesce(btrim(p_grund), '') = '' then raise exception 'Bitte einen Grund angeben' using errcode = '22023'; end if;
  select * into f from public.fuhren_liste where id = p_fuhre;
  if not found or f.storniert_am is not null then raise exception 'Fuhre nicht gefunden oder storniert' using errcode = '22023'; end if;
  if not (f.hat_lieferschein and f.hat_wiegeschein) then
    raise exception 'Lieferschein und Wiegeschein müssen da sein' using errcode = '22023';
  end if;
  update public.fuhren set abgeschlossen_am = now(), abgeschlossen_von = auth.jwt() ->> 'email', abschluss_grund = btrim(p_grund)
   where id = p_fuhre;
  perform intern.fuhre_komplett_pruefen(p_fuhre);
end $$;
revoke all on function public.fuhre_abschliessen(bigint, text) from public, anon, authenticated;
grant execute on function public.fuhre_abschliessen(bigint, text) to authenticated;

-- Komplett = Lieferschein + Wiegeschein + (Begleitschein oder abgeschlossen)
create or replace function intern.fuhre_komplett_pruefen(p_fuhre bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare f public.fuhren_liste%rowtype;
begin
  select * into f from public.fuhren_liste where id = p_fuhre;
  if not found or f.storniert_am is not null or f.quelle <> 'app' or f.weitergegeben_am is not null then return; end if;
  if not (f.hat_lieferschein and f.hat_wiegeschein and (f.hat_begleitschein or f.abgeschlossen_am is not null)) then return; end if;
  if not exists (select 1 from vault.secrets where name = 'github_gedaechtnis') then return; end if;
  update public.fuhren set weitergabe_angestossen_am = now() where id = p_fuhre;
  perform intern.fuhren_github_aufrufen(jsonb_build_object('aktion', 'weitergeben', 'fuhre_id', p_fuhre));
end $$;
