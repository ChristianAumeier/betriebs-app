-- Leere Fuhre löschen (Christian, 29.10.2026): Versehentlich doppelt angelegte Fuhren ohne jeden Scan.
-- Ausnahme von „nichts wird gelöscht“: Eine solche Fuhre enthält keine Daten außer Anlegezeit und Fahrer.
-- Nur Chef, nur Fuhren aus der App, ohne Beleg (auch keinen als falsch markierten), ohne Datei im Speicher,
-- nicht gesendet, nicht weitergegeben, nicht ausgelesen. Alles andere wird weiter storniert.
create or replace function public.fuhre_loeschen(p_fuhre bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare f public.fuhren%rowtype;
begin
  if not public.ist_chef() then raise exception 'Nur für Christian und Carolin' using errcode = '42501'; end if;
  select * into f from public.fuhren where id = p_fuhre for update;
  if not found then raise exception 'Fuhre nicht gefunden' using errcode = '22023'; end if;
  if f.quelle <> 'app' or f.abgesendet_am is not null or f.weitergegeben_am is not null or f.ausgelesen_am is not null
     or exists (select 1 from public.belege b where b.fuhre_id = p_fuhre)
     or exists (select 1 from storage.objects o where o.bucket_id = 'belege' and o.name like 'fuhren/' || p_fuhre || '/%') then
    raise exception 'Nur leere Fuhren ohne Scans lassen sich löschen. Diese Fuhre bitte stornieren.' using errcode = '22023';
  end if;
  delete from public.fuhren where id = p_fuhre;
end $$;
revoke all on function public.fuhre_loeschen(bigint) from public, anon, authenticated;
grant execute on function public.fuhre_loeschen(bigint) to authenticated;
