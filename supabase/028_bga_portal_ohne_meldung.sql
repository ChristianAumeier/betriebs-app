-- 028: Keine Störungsmeldungen mehr zum Bayernwerk-Portal (Christian, 29.10.2026: „brauche ich nicht, sonst steht
-- andauernd die rote Meldung in der App“). Prüfung bga_portal_pruefen (024) abgeschaltet, offene Meldungen still
-- geschlossen (push_behoben = true, also keine Mitteilung „behoben“). Lastgang-Tabellen und rpc/bga_portal_melden bleiben.
-- Wieder einschalten: select cron.schedule('bga_portal_pruefen', '1-59/5 * * * *', 'select intern.bga_portal_pruefen()');
select cron.unschedule('bga_portal_pruefen') where exists (select 1 from cron.job where jobname = 'bga_portal_pruefen');

update public.stoerungen
   set behoben_am = coalesce(behoben_am, now()), push_behoben = true,
       gelesen_am = coalesce(gelesen_am, now()), gelesen_email = coalesce(gelesen_email, 'abgeschaltet (028)')
 where schluessel in ('bga_portal', 'bga_portal_auslesen') and (behoben_am is null or gelesen_am is null);
