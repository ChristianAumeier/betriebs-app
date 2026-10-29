-- 023: Lastgänge der Biogasanlage aus dem Bayernwerk-Kundenportal
-- Claude liest täglich per geplanter Aufgabe im angemeldeten Chrome aus und schreibt hierher.
-- Grundlage für die Prüfung der Bayernwerk-Abrechnungen.

-- Einträge im Portal (Messpunkt bzw. Marktlokation + OBIS)
create table if not exists public.bga_lastgang_eintrag (
  eintrag_id  text primary key,          -- z. B. '50310263137|1-1:2.29.0'
  energieart  text not null,             -- so wie im Portal, z. B. 'Einspeisung Photovoltaik'
  meldepunkt  text not null,
  obis        text not null,
  zaehler     text,                      -- Zählernummern laut Portal
  bemerkung   text,
  zuerst_gesehen timestamptz not null default now(),
  zuletzt_gesehen timestamptz not null default now()
);

-- Viertelstundenwerte (kWh je Viertelstunde, Zeit = Beginn in UTC)
create table if not exists public.bga_lastgang_qh (
  eintrag_id text not null references public.bga_lastgang_eintrag(eintrag_id),
  zeit       timestamptz not null,
  kwh        numeric,
  gelesen_am timestamptz not null default now(),
  primary key (eintrag_id, zeit)
);

-- Tagessummen (deutscher Kalendertag)
create table if not exists public.bga_lastgang_tag (
  eintrag_id text not null references public.bga_lastgang_eintrag(eintrag_id),
  datum      date not null,
  kwh        numeric not null,
  viertelstunden int not null,
  gelesen_am timestamptz not null default now(),
  primary key (eintrag_id, datum)
);

-- Protokoll der Abrufe (Wachhalten und Auslesen)
create table if not exists public.bga_portal_abruf (
  id     bigint generated always as identity primary key,
  zeit   timestamptz not null default now(),
  art    text not null,                  -- 'wachhalten' oder 'auslesen'
  ok     boolean not null,
  text   text
);

alter table public.bga_lastgang_eintrag enable row level security;
alter table public.bga_lastgang_qh enable row level security;
alter table public.bga_lastgang_tag enable row level security;
alter table public.bga_portal_abruf enable row level security;

create policy bga_eintrag_chef on public.bga_lastgang_eintrag for select to authenticated using (public.ist_chef());
create policy bga_qh_chef on public.bga_lastgang_qh for select to authenticated using (public.ist_chef());
create policy bga_tag_chef on public.bga_lastgang_tag for select to authenticated using (public.ist_chef());
create policy bga_abruf_chef on public.bga_portal_abruf for select to authenticated using (public.ist_chef());

grant select on public.bga_lastgang_eintrag, public.bga_lastgang_qh, public.bga_lastgang_tag, public.bga_portal_abruf to authenticated;

-- Speichert einen ausgelesenen Lastgang. p_werte = [[zeit_ms_utc, kwh], ...]
create or replace function intern.bga_lastgang_speichern(
  p_energieart text, p_meldepunkt text, p_obis text, p_zaehler text, p_werte jsonb)
returns int
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_id text := p_meldepunkt || '|' || p_obis;
  n int;
begin
  insert into public.bga_lastgang_eintrag (eintrag_id, energieart, meldepunkt, obis, zaehler)
  values (v_id, p_energieart, p_meldepunkt, p_obis, p_zaehler)
  on conflict (eintrag_id) do update
    set energieart = excluded.energieart, zaehler = excluded.zaehler, zuletzt_gesehen = now();

  insert into public.bga_lastgang_qh (eintrag_id, zeit, kwh)
  select v_id, to_timestamp((w->>0)::double precision / 1000), nullif(w->>1, '')::numeric
  from jsonb_array_elements(p_werte) w
  on conflict (eintrag_id, zeit) do update set kwh = excluded.kwh, gelesen_am = now();
  get diagnostics n = row_count;

  insert into public.bga_lastgang_tag (eintrag_id, datum, kwh, viertelstunden)
  select v_id, (q.zeit at time zone 'Europe/Berlin')::date, sum(q.kwh), count(q.kwh)
  from public.bga_lastgang_qh q
  where q.eintrag_id = v_id
    and (q.zeit at time zone 'Europe/Berlin')::date in (
      select distinct (to_timestamp((w->>0)::double precision / 1000) at time zone 'Europe/Berlin')::date
      from jsonb_array_elements(p_werte) w)
  group by 2
  on conflict (eintrag_id, datum) do update
    set kwh = excluded.kwh, viertelstunden = excluded.viertelstunden, gelesen_am = now();
  return n;
end $$;

revoke all on function intern.bga_lastgang_speichern(text, text, text, text, jsonb) from public, anon, authenticated;
