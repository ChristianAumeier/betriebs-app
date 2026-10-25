-- 016: Doppelt erfasste Fuhren erkennen. Hat eine ausgelesene Fuhre dieselbe Auftragsnummer (Wiegeschein) wie eine
-- andere, nicht stornierte Fuhre, wird sie als auffällig markiert („Doppelt erfasst?“) und die Chefs bekommen eine
-- Mitteilung. Entscheiden (eine davon stornieren) tut der Chef. Sonst wie 013. Ohne „drop“ geschrieben.

create or replace function public.fuhre_ergebnis_speichern(p_fuhre bigint, p_e jsonb, p_sha text)
returns void language plpgsql security definer set search_path = '' as $$
declare l bigint;
        f public.fuhren%rowtype;
        neu boolean := false;
        doppelt text;
        auftrag text := nullif(btrim(p_e ->> 'auftrag_nr'), '');
        hinweis text;
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
    auffaellig = coalesce((p_e ->> 'auffaellig')::boolean, false) or neu or doppelt is not null,
    hinweise = hinweis,
    ergebnis = p_e, ergebnis_sha = p_sha, ausgelesen_am = now()
  where id = p_fuhre;
  if coalesce((p_e ->> 'auffaellig')::boolean, false) or neu or doppelt is not null then
    perform intern.push_ausloesen(jsonb_build_array(jsonb_build_object(
      'titel', 'Fuhre prüfen',
      'text', 'Fuhre vom ' || to_char(coalesce(nullif(p_e ->> 'datum', '')::date, f.datum), 'DD.MM.') || ': ' || coalesce(hinweis, 'bitte ansehen'),
      'ziel', '#bahnschwellen/' || p_fuhre)));
  end if;
end $$;
revoke all on function public.fuhre_ergebnis_speichern(bigint, jsonb, text) from public, anon, authenticated;
grant execute on function public.fuhre_ergebnis_speichern(bigint, jsonb, text) to service_role;
