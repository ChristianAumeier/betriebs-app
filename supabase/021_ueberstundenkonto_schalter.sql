-- 021: Überstundenkonto je Person an/aus (Christian, 26.10.2026)
-- Wer ein Festgehalt ohne Überstundenkonto hat (Jürgen Ungefug): nur Stunden erfassen und Urlaub, keine Sollstunden.

alter table public.personen add column if not exists ueberstundenkonto boolean not null default true;

create or replace function public.person_ueberstundenkonto_setzen(p_user uuid, p_an boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.ist_chef() then raise exception 'Dafür fehlt die Berechtigung' using errcode = '42501'; end if;
  update public.personen set ueberstundenkonto = p_an where user_id = p_user;
  if not found then raise exception 'Person nicht gefunden' using errcode = '22023'; end if;
end $$;
revoke all on function public.person_ueberstundenkonto_setzen(uuid, boolean) from public, anon, authenticated;
grant execute on function public.person_ueberstundenkonto_setzen(uuid, boolean) to authenticated;
