-- 007: Die Edge Function push-senden arbeitet als service_role. Neue Tabellen bekommen in diesem Projekt
-- keine Rechte automatisch („Automatically expose new tables“ aus), deshalb hier ausdrücklich.
-- Lehre: Bei jeder Tabelle, die eine Edge Function lesen oder ändern soll, service_role Rechte geben.
-- Als Migration angewendet (2026-10-23).
grant select, update, delete on public.push_abos to service_role;
