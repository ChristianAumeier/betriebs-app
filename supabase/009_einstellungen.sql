-- 009: Einstellungen, die die App setzt und der Home Assistant abholt (Richtung App → Home Assistant).
-- Erste Einstellung: wallbox_mindest_soc = bis zu diesem Ladezustand (%) lädt die Wallbox immer voll,
-- darüber nur mit PV-Überschuss. Ersetzt „Winterladen“ (100 % = immer voll laden).
-- Als Migration angewendet (2026-10-23).
create table if not exists public.einstellungen (
  name text primary key,
  wert jsonb not null,
  geaendert_am timestamptz not null default now(),
  geaendert_von text
);
alter table public.einstellungen enable row level security;
revoke all on public.einstellungen from public, anon, authenticated;
grant select on public.einstellungen to authenticated;
drop policy if exists "Lesen nur nach Anmeldung mit Code" on public.einstellungen;
create policy "Lesen nur nach Anmeldung mit Code" on public.einstellungen for select to authenticated
  using ((auth.jwt() ->> 'aal') = 'aal2');

insert into public.einstellungen (name, wert, geaendert_von)
values ('wallbox_mindest_soc', '100'::jsonb, 'Startwert (wie Winterladen)')
on conflict (name) do nothing;

-- Setzen aus der App (nur mit Anmeldung + Code, nur bekannte Namen und gültige Werte)
create or replace function public.einstellung_setzen(p_name text, p_wert jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or (auth.jwt() ->> 'aal') is distinct from 'aal2' then
    raise exception 'Nur nach Anmeldung mit Code' using errcode = '42501';
  end if;
  if p_name = 'wallbox_mindest_soc' then
    if jsonb_typeof(p_wert) <> 'number' or (p_wert #>> '{}')::numeric not between 0 and 100 then
      raise exception 'Wert muss eine Zahl zwischen 0 und 100 sein' using errcode = '22023';
    end if;
    p_wert := to_jsonb(round((p_wert #>> '{}')::numeric));
  else
    raise exception 'Unbekannte Einstellung: %', p_name using errcode = '22023';
  end if;
  insert into public.einstellungen (name, wert, geaendert_am, geaendert_von)
  values (p_name, p_wert, now(), auth.jwt() ->> 'email')
  on conflict (name) do update set wert = excluded.wert, geaendert_am = now(), geaendert_von = excluded.geaendert_von;
end $$;

-- Abholen durch den Home Assistant (gleicher Schlüssel wie ha_melden)
create or replace function public.ha_einstellungen()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare k text := current_setting('request.headers', true)::json ->> 'x-ha-schluessel';
begin
  if k is null or not exists (select 1 from intern.schluessel s where s.name = 'homeassistant'
      and s.hash = encode(sha256(convert_to(k, 'UTF8')), 'hex')) then
    raise exception 'Schlüssel ungültig' using errcode = '42501';
  end if;
  return coalesce((select jsonb_object_agg(name, wert) from public.einstellungen), '{}'::jsonb);
end $$;

revoke all on function public.einstellung_setzen(text, jsonb) from public, anon, authenticated;
revoke all on function public.ha_einstellungen() from public, anon, authenticated;
grant execute on function public.einstellung_setzen(text, jsonb) to authenticated;
grant execute on function public.ha_einstellungen() to anon;
