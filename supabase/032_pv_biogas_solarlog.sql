-- 032: PV an der Biogasanlage (Solar-Log Base 2000, Portal stuber-sonne.enerest.world).
-- Ohne API-Schlüssel kann Supabase den Solar-Log nicht selbst abfragen. Ein Skript im angemeldeten
-- Solar-Log-Tab am Büro-PC (werkzeuge/solarlog-melder.js) schickt alle 5 Minuten die Werte je
-- Wechselrichter über rpc/pvbga_melden. Schlüssel nur im Browser, hier nur sein Hash (intern.schluessel, Name 'solarlog').
-- Anlagen laut Christian (07.11.2026): neu 570 kWp, alt 108 kWp. kwp je Wechselrichter = Solar-Log-Konfiguration.

create table if not exists public.pvbga_wechselrichter (
  id         text primary key,            -- crossEpochId im Solar-Log-Portal
  name       text not null,
  anlage     text not null check (anlage in ('neu', 'alt')),
  kwp        numeric,                     -- Modulleistung laut Solar-Log (alt: Platzhalter 15 kWp)
  sortierung int not null default 0
);

create table if not exists public.pvbga_live (
  id          text primary key references public.pvbga_wechselrichter(id),
  messung_am  timestamptz,                -- Zeitpunkt des letzten 5-Minuten-Werts im Solar-Log
  leistung_w  numeric,
  heute_kwh   numeric,
  gemeldet_am timestamptz not null default now()
);

create table if not exists public.pvbga_tag (
  id  text not null references public.pvbga_wechselrichter(id),
  tag date not null,
  kwh numeric not null,
  primary key (id, tag)
);

create table if not exists public.pvbga_abruf (
  id int primary key default 1 check (id = 1),
  letzter_erfolg timestamptz,
  fehler text,
  fehler_am timestamptz
);
insert into public.pvbga_abruf (id) values (1) on conflict do nothing;

alter table public.pvbga_wechselrichter enable row level security;
alter table public.pvbga_live enable row level security;
alter table public.pvbga_tag enable row level security;
alter table public.pvbga_abruf enable row level security;
create policy pvbga_wr_chef on public.pvbga_wechselrichter for select to authenticated using (public.ist_chef());
create policy pvbga_live_chef on public.pvbga_live for select to authenticated using (public.ist_chef());
create policy pvbga_tag_chef on public.pvbga_tag for select to authenticated using (public.ist_chef());
create policy pvbga_abruf_chef on public.pvbga_abruf for select to authenticated using (public.ist_chef());
grant select on public.pvbga_wechselrichter, public.pvbga_live, public.pvbga_tag, public.pvbga_abruf to authenticated;

-- p_daten = { geraete: [{id, name, kwp, sortierung, messung_am, leistung_w, heute_kwh}],
--             tage: [{id, tag, kwh}] }   oder   { fehler: 'Text' }
create or replace function public.pvbga_melden(p_schluessel text, p_daten jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  g jsonb;
  n_tage int := 0;
begin
  if p_schluessel is null or not exists (
    select 1 from intern.schluessel s
    where s.name = 'solarlog' and s.hash = encode(sha256(convert_to(p_schluessel, 'UTF8')), 'hex')
  ) then
    raise exception 'Schlüssel ungültig' using errcode = '42501';
  end if;

  if p_daten ? 'fehler' then
    update public.pvbga_abruf set fehler = left(p_daten->>'fehler', 500), fehler_am = now() where id = 1;
    return jsonb_build_object('ok', true);
  end if;

  for g in select * from jsonb_array_elements(coalesce(p_daten->'geraete', '[]'::jsonb)) loop
    insert into public.pvbga_wechselrichter (id, name, anlage, kwp, sortierung)
    values (g->>'id', g->>'name', case when g->>'name' ilike '%bestand%' then 'alt' else 'neu' end,
            nullif(g->>'kwp', '')::numeric, coalesce((g->>'sortierung')::int, 0))
    on conflict (id) do update set name = excluded.name, anlage = excluded.anlage, kwp = excluded.kwp,
      sortierung = excluded.sortierung;
    insert into public.pvbga_live (id, messung_am, leistung_w, heute_kwh, gemeldet_am)
    values (g->>'id', nullif(g->>'messung_am', '')::timestamptz, nullif(g->>'leistung_w', '')::numeric,
            nullif(g->>'heute_kwh', '')::numeric, now())
    on conflict (id) do update set messung_am = excluded.messung_am, leistung_w = excluded.leistung_w,
      heute_kwh = excluded.heute_kwh, gemeldet_am = now();
  end loop;

  insert into public.pvbga_tag (id, tag, kwh)
  select t->>'id', (t->>'tag')::date, (t->>'kwh')::numeric
  from jsonb_array_elements(coalesce(p_daten->'tage', '[]'::jsonb)) t
  where exists (select 1 from public.pvbga_wechselrichter w where w.id = t->>'id')
  on conflict (id, tag) do update set kwh = excluded.kwh;
  get diagnostics n_tage = row_count;

  update public.pvbga_abruf set letzter_erfolg = now(), fehler = null, fehler_am = null where id = 1;
  return jsonb_build_object('ok', true, 'tage', n_tage);
end $$;

grant execute on function public.pvbga_melden(text, jsonb) to anon, authenticated;
