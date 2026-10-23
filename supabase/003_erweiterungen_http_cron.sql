-- 003: Erweiterungen für Abrufe aus der Datenbank heraus (kostenlos).
-- http = Webseiten synchron abfragen (bei Growatt-POST leider SSL-Fehler, siehe 004)
-- pg_cron = Zeitplaner in der Datenbank
-- Als Migration angewendet (2026-10-23).
create extension if not exists http with schema extensions;
create extension if not exists pg_cron;
