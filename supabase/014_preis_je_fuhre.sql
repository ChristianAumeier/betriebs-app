-- 014: Vergütung je Ladestelle entweder pro Schwelle oder pro Fuhre (z. B. Büchenbach: fester Betrag je Fuhre).
-- Hängt immer an der Ladestelle (Christian, 25.10.2026); mit „gültig ab“ wie bisher.
-- Die Spalte preis_schwelle bleibt (Name aus 013) und enthält jetzt den Betrag; art sagt, wofür er gilt.
-- Ohne „drop“ geschrieben (siehe Lehre in CLAUDE.md).

alter table public.ladestellen_preise add column if not exists art text not null default 'schwelle'
  check (art in ('schwelle', 'fuhre'));

-- Preis setzen mit Art (die bisherige Form ohne Art bleibt und bedeutet „pro Schwelle“)
create or replace function public.preis_setzen(p_ladestelle bigint, p_gueltig_ab date, p_preis numeric, p_art text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.ist_chef() then raise exception 'Nur für Christian und Carolin' using errcode = '42501'; end if;
  if p_preis is null or p_preis < 0 then raise exception 'Bitte einen Preis angeben' using errcode = '22023'; end if;
  if p_art not in ('schwelle', 'fuhre') then raise exception 'Unbekannte Abrechnung: %', p_art using errcode = '22023'; end if;
  insert into public.ladestellen_preise (ladestelle_id, gueltig_ab, preis_schwelle, art, angelegt_von)
  values (p_ladestelle, p_gueltig_ab, round(p_preis, 2), p_art, auth.jwt() ->> 'email')
  on conflict (ladestelle_id, gueltig_ab) do update set preis_schwelle = excluded.preis_schwelle, art = excluded.art,
    angelegt_am = now(), angelegt_von = excluded.angelegt_von;
end $$;
revoke all on function public.preis_setzen(bigint, date, numeric, text) from public, anon, authenticated;
grant execute on function public.preis_setzen(bigint, date, numeric, text) to authenticated;
