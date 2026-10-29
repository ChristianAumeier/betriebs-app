-- 025: Tagessummen der Bayernwerk-Lastgänge nur für vollständige Tage bilden.
-- Vorher hat ein angefangener erster Tag (nur einige Viertelstunden) die richtige Tagessumme überschrieben.
create or replace function intern.bga_lastgang_speichern(
  p_energieart text, p_meldepunkt text, p_obis text, p_zaehler text, p_werte jsonb)
returns int language plpgsql security definer set search_path to '' as $$
declare v_id text := p_meldepunkt || '|' || p_obis; n int;
begin
  insert into public.bga_lastgang_eintrag (eintrag_id, energieart, meldepunkt, obis, zaehler)
  values (v_id, p_energieart, p_meldepunkt, p_obis, p_zaehler)
  on conflict (eintrag_id) do update set energieart = excluded.energieart, zaehler = excluded.zaehler, zuletzt_gesehen = now();
  insert into public.bga_lastgang_qh (eintrag_id, zeit, kwh)
  select v_id, to_timestamp((w->>0)::double precision / 1000), nullif(w->>1, '')::numeric
  from jsonb_array_elements(p_werte) w
  on conflict (eintrag_id, zeit) do update set kwh = excluded.kwh, gelesen_am = now();
  get diagnostics n = row_count;
  -- Tagessumme nur für vollständige Tage (92 Viertelstunden am Tag der Sommerzeit-Umstellung)
  insert into public.bga_lastgang_tag (eintrag_id, datum, kwh, viertelstunden)
  select v_id, (q.zeit at time zone 'Europe/Berlin')::date, sum(q.kwh), count(q.kwh)
  from public.bga_lastgang_qh q
  where q.eintrag_id = v_id and (q.zeit at time zone 'Europe/Berlin')::date in (
      select distinct (to_timestamp((w->>0)::double precision / 1000) at time zone 'Europe/Berlin')::date from jsonb_array_elements(p_werte) w)
  group by 2
  having count(q.kwh) >= 92
  on conflict (eintrag_id, datum) do update set kwh = excluded.kwh, viertelstunden = excluded.viertelstunden, gelesen_am = now();
  return n;
end $$;

-- 26.10.2026 auf die Werte aus der Erstauslesung zurücksetzen
update public.bga_lastgang_tag t set kwh = v.kwh, viertelstunden = 96 from (values
 ('50310068917|1-1:2.29.0', 11145.7), ('50310263137|1-1:2.29.0', 306.5),
 ('DE0010688406910000000000003967999|1-1:1.29.0', 984.8), ('DE0010688406910000000000003967999|1-1:2.29.0', 18.2),
 ('DE00106884069S1600000000000077786|1-1:1.29.0', 0), ('DE00106884069S1600000000000077786|1-1:2.29.0', 12418.8),
 ('DE00106884069S1600000000000150845|1-1:2.29.0', 306.5)) v(id, kwh)
where t.eintrag_id = v.id and t.datum = date '2026-10-26';
