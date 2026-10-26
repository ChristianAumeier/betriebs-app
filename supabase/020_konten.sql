-- 020: Arbeitsvertrag je Person und Startstand für Resturlaub und Überstundenkonto (Christian, 26.10.2026)
-- Je Festangestelltem: Urlaubstage pro Jahr, Sollstunden pro Monat.
-- konto_start: Stand am Abend des Stichtags (Resturlaub in Tagen, Überstunden in Stunden), von Christian genannt.
-- Gerechnet wird in der App (stempeln.js, konto()) ab dem Tag nach dem Stichtag:
--   Tagessoll = Sollstunden pro Monat / Wochentage (Mo–Fr) des Monats, Feiertage mitgezählt
--   Überstunden = Start + gearbeitete Stunden + Tagessoll für jeden Urlaubs-, Krank- und Feiertag − Tagessoll je Wochentag
--   Resturlaub = Start + Urlaubstage pro Jahr ab jedem neuen Jahr − eingetragene Urlaubstage
-- „Frei“ bekommt nichts gutgeschrieben (z. B. Überstunden abbauen).
-- Die Tabelle urlaubsanspruch (019) wird dafür nicht mehr benutzt.

alter table public.personen add column if not exists urlaub_tage_jahr numeric check (urlaub_tage_jahr between 0 and 60);
alter table public.personen add column if not exists soll_std_monat numeric check (soll_std_monat between 0 and 300);

create table if not exists public.konto_start (
  user_id uuid primary key references public.personen(user_id),
  stichtag date not null,
  urlaub_rest numeric not null default 0,
  ueberstunden numeric not null default 0,
  notiz text,
  geaendert_am timestamptz not null default now(),
  geaendert_von uuid
);
alter table public.konto_start enable row level security;
revoke all on public.konto_start from public, anon, authenticated;
grant select on public.konto_start to authenticated;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'konto_start' and policyname = 'Eigene oder Chef') then
    create policy "Eigene oder Chef" on public.konto_start for select to authenticated
      using (((auth.jwt() ->> 'aal') = 'aal2') and (user_id = auth.uid() or public.ist_chef()));
  end if;
end $$;

-- Chef: Urlaubstage pro Jahr und Sollstunden pro Monat
create or replace function public.person_vertrag_setzen(p_user uuid, p_urlaub_tage_jahr numeric, p_soll_std_monat numeric)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.ist_chef() then raise exception 'Dafür fehlt die Berechtigung' using errcode = '42501'; end if;
  update public.personen set urlaub_tage_jahr = p_urlaub_tage_jahr, soll_std_monat = p_soll_std_monat where user_id = p_user;
  if not found then raise exception 'Person nicht gefunden' using errcode = '22023'; end if;
end $$;

-- Chef: Startstand
create or replace function public.konto_start_setzen(p_user uuid, p_stichtag date, p_urlaub_rest numeric, p_ueberstunden numeric, p_notiz text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.ist_chef() then raise exception 'Dafür fehlt die Berechtigung' using errcode = '42501'; end if;
  insert into public.konto_start (user_id, stichtag, urlaub_rest, ueberstunden, notiz, geaendert_von)
  values (p_user, p_stichtag, p_urlaub_rest, p_ueberstunden, nullif(btrim(p_notiz), ''), auth.uid())
  on conflict (user_id) do update set stichtag = excluded.stichtag, urlaub_rest = excluded.urlaub_rest,
    ueberstunden = excluded.ueberstunden, notiz = excluded.notiz, geaendert_am = now(), geaendert_von = auth.uid();
end $$;

revoke all on function public.person_vertrag_setzen(uuid, numeric, numeric) from public, anon, authenticated;
revoke all on function public.konto_start_setzen(uuid, date, numeric, numeric, text) from public, anon, authenticated;
grant execute on function public.person_vertrag_setzen(uuid, numeric, numeric) to authenticated;
grant execute on function public.konto_start_setzen(uuid, date, numeric, numeric, text) to authenticated;
