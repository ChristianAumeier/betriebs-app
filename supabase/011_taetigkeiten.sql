-- 011: Tätigkeit des Tages (Mitarbeiter schreibt frei, was er gemacht hat) und Personen bearbeiten.
-- Tätigkeiten werden nie geändert: Speichern legt eine neue Zeile an, angezeigt wird die neueste je Tag.
-- Ohne „drop“ geschrieben (siehe Lehre in CLAUDE.md).

create table if not exists public.taetigkeiten (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id),
  tag date not null,
  text text not null check (char_length(btrim(text)) between 1 and 500),
  angelegt_am timestamptz not null default now(),
  angelegt_von uuid not null
);
create index if not exists taetigkeiten_user_tag on public.taetigkeiten (user_id, tag, id);
alter table public.taetigkeiten enable row level security;
revoke all on public.taetigkeiten from public, anon, authenticated;
grant select on public.taetigkeiten to authenticated;
create policy "Eigene Tätigkeiten oder Chef" on public.taetigkeiten for select to authenticated
  using ((auth.jwt() ->> 'aal') = 'aal2' and (user_id = auth.uid() or public.ist_chef()));

-- Speichern: für sich selbst, Tag heute oder bis zu zwei Monate zurück (deutsche Zeit)
create or replace function public.taetigkeit_speichern(p_tag date, p_text text)
returns void language plpgsql security definer set search_path = '' as $$
declare heute date := (now() at time zone 'Europe/Berlin')::date;
begin
  if auth.uid() is null or (auth.jwt() ->> 'aal') is distinct from 'aal2' then
    raise exception 'Nur nach Anmeldung mit Code' using errcode = '42501';
  end if;
  if not exists (select 1 from public.personen where user_id = auth.uid() and stempelt) then
    raise exception 'Für dieses Konto ist Stempeln nicht vorgesehen' using errcode = '42501';
  end if;
  if p_tag > heute or p_tag < heute - 62 then
    raise exception 'Der Tag muss zwischen % und heute liegen', to_char(heute - 62, 'DD.MM.YYYY') using errcode = '22023';
  end if;
  if coalesce(btrim(p_text), '') = '' then
    raise exception 'Bitte etwas eintragen' using errcode = '22023';
  end if;
  insert into public.taetigkeiten (user_id, tag, text, angelegt_von) values (auth.uid(), p_tag, btrim(p_text), auth.uid());
end $$;

-- Chef: Name ändern, Stempeln an/aus (Rolle bleibt)
create or replace function public.person_bearbeiten(p_user uuid, p_name text, p_stempelt boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.ist_chef() then raise exception 'Nur für Christian und Carolin' using errcode = '42501'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'Bitte einen Namen angeben' using errcode = '22023'; end if;
  update public.personen set name = btrim(p_name), stempelt = p_stempelt where user_id = p_user;
  if not found then raise exception 'Person nicht gefunden' using errcode = '22023'; end if;
end $$;

revoke all on function public.taetigkeit_speichern(date, text) from public, anon, authenticated;
revoke all on function public.person_bearbeiten(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.taetigkeit_speichern(date, text) to authenticated;
grant execute on function public.person_bearbeiten(uuid, text, boolean) to authenticated;
-- Die Edge Function konto-anlegen (service_role) setzt den Namen der neuen Person
grant select, update on public.personen to service_role;
