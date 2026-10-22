-- 002: Bilder für die App, nur nach Anmeldung mit Code lesbar.
-- Bilder gehören nicht ins öffentliche Repository (fremde Rechte, private Fotos).
-- Klein halten (unter ca. 200 KB), sie werden als Text (Base64) gespeichert.
-- Als Migration angewendet (Supabase-Connector, 2026-10-22).

create table if not exists public.bilder (
  name text primary key,
  typ text not null,          -- z. B. image/webp
  daten text not null,        -- Base64
  geaendert_am timestamptz not null default now()
);

alter table public.bilder enable row level security;
revoke all on public.bilder from public, anon, authenticated;
grant select on public.bilder to authenticated;

drop policy if exists "Lesen nur nach Anmeldung mit Code" on public.bilder;
create policy "Lesen nur nach Anmeldung mit Code" on public.bilder
  for select to authenticated
  using ((auth.jwt() ->> 'aal') = 'aal2');

-- Inhalt wird nicht hier eingetragen, sondern von Claude direkt (z. B. Name 'auto').
