-- 008: Wichtige Störungen bleiben in der App stehen, bis jemand „Gelesen“ tippt,
-- auch wenn sie sich inzwischen von selbst erledigt haben. Wer wann gelesen hat, wird gespeichert.
-- Als Migration angewendet (2026-10-23).
alter table public.stoerungen
  add column if not exists gelesen_am timestamptz,
  add column if not exists gelesen_von uuid references auth.users(id),
  add column if not exists gelesen_email text;

create or replace function public.stoerung_gelesen(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or (auth.jwt() ->> 'aal') is distinct from 'aal2' then
    raise exception 'Nur nach Anmeldung mit Code' using errcode = '42501';
  end if;
  update public.stoerungen
     set gelesen_am = now(), gelesen_von = auth.uid(), gelesen_email = auth.jwt() ->> 'email'
   where id = p_id and gelesen_am is null;
end $$;

revoke all on function public.stoerung_gelesen(bigint) from public, anon, authenticated;
grant execute on function public.stoerung_gelesen(bigint) to authenticated;
