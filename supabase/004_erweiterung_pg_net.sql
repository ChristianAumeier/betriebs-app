-- 004: pg_net = Webseiten asynchron abfragen (funktioniert mit Growatt, Antworten in net._http_response).
-- Als Migration angewendet (2026-10-23).
create extension if not exists pg_net with schema extensions;
