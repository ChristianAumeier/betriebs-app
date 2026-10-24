# Betriebs-App Aumeier

Gedächtnis-Dokument für Claude Code. Bei jedem Start zuerst lesen, nach jeder Entscheidung fortschreiben.

## Wer ich bin und wie wir arbeiten

- Auftraggeber: Christian Aumeier, Landwirt (Bioland) und Betreiber einer Biogasanlage, Schierling (Bayern).
- Christian programmiert nicht. Erkläre jeden Schritt in einfachen Worten, auf Deutsch.
- Eine Sache pro Auftrag. Prüfe jede Änderung, bevor du sie vorlegst, und sag, was du geprüft hast und was nicht.
- Trage jede Entscheidung und jede Lehre aus einem Fehler in diese Datei ein (Abschnitt „Entscheidungen“).
- Jede Änderung bekommt eine Versionsnummer, die unten in der App steht (v1, v2, …).
- Fertig ist etwas erst, wenn Christian es am Handy geprüft hat.
- Christian gibt dir nie Passwörter oder den Supabase-Hauptschlüssel (service_role).
- Seit 2026-10-22: Claude erledigt alles selbst (Supabase über den Supabase-Connector, Home Assistant über die Dateien auf `\\HOMESERVER\docker\homeassistant` und die HA-Schnittstelle, Git, Hochladen). Christian kopiert nichts und klickt nicht in Dashboards. Vor Störendem oder Unumkehrbarem (Home-Assistant-Neustart, Löschen, Kosten) fragt Claude kurz mit einem Satz (ja/nein). Die NAS wird nie neu gestartet.
- Schlüssel gehen nur von Maschine zu Maschine: Claude erzeugt sie lokal und schreibt sie direkt dorthin, wo sie gebraucht werden (z. B. `secrets.yaml`). Sie erscheinen nie im Chat, in einer Ausgabe oder im Repository. In der Datenbank steht nur die Prüfsumme.

## Ziel und Abgrenzung

Die App dokumentiert und kontrolliert: was wann, von wem, wohin, in welcher Menge bewegt wurde, und ob es stimmt. Nachweise für Bioland, Umweltgutachter (EEG) und Finanzamt.

Die App macht ausdrücklich nicht:
- Anlagen regeln. Biogas, BHKWs, Speicher und PV werden von ihren Steuerungen geregelt.
- In die Fernwirktechnik des Bayernwerks eingreifen. Höchstens Mitlesen über eine getrennte Leseschnittstelle.
- Buchhaltung. Die App liefert Belege und Exporte für DATEV Unternehmen online, sie bucht nicht.

## Die Betriebe (Mandanten)

Jede Bewegung und jeder Beleg gehört genau einem Betrieb. Jeder Betrieb ist in DATEV Unternehmen online ein eigenes Unternehmen.

| Betrieb | Was dazugehört | Kürzel |
| --- | --- | --- |
| Landwirtschaft | Ackerbau nach Bioland, Getreidelager | LW |
| Biogasanlage | Fermenter, BHKWs, PV-Anlage mit Speicher | BG |
| Maschinenvermietung Carolin Aumeier | Vermietmaschinen, LKW für Bahnschwellen-Transporte im Fremdauftrag; gewerblich | MC |
| Landwirtschaft Carolin Aumeier | nicht buchführungspflichtig | LC |
| Maschinenvermietung Christian Aumeier | bisher keine Vorgänge | MA |
| Privat | PV-Anlage privat | PR |

Folgen:
1. Nummernkreise je Betrieb und Jahr, z. B. `LW-2026-00012`. Die Nummer vergibt die Datenbank, lückenlos.
2. Die Betriebe sind untereinander Partner. Leistungen zwischen zwei Betrieben (z. B. Mais von LW an BG, Maschine von MC an LW) bekommen immer einen eigenen Beleg.
3. Ein Zugang, der Betrieb ist oben umschaltbar. Auswertungen je Betrieb oder über alle.
4. DATEV-Export je Betrieb getrennt.
5. Privat erscheint nie in einem betrieblichen Export.

## Grundmodell

Fast alles ist eine **Warenbewegung**: Datum, Betrieb, Partner, Produkt, Menge, von → nach, Beleg. Getreidelager und Biogas sind zwei Ansichten auf dieselben Daten. Bestände ergeben sich aus den Bewegungen.

Ebenen:
- Fundament (für alle Betriebe gleich): Betriebe, Benutzer und Rollen, Stammdaten, Nummernkreise, Protokoll.
- Kern: Warenbewegungen.
- Module darauf (siehe Reihenfolge).

Stammdaten:
- Partner: Lieferanten, Abnehmer, Händler, Lohnunternehmer, Mieter; die eigenen Betriebe
- Produkte: Weizen, Dinkel, Mais, Gülle, Gärrest …, jeweils mit Bio-Status
- Orte: Lagerzellen, Fermenter, Felder
- Maschinen und Fahrzeuge: mit Betrieb und Kennzeichen
- Anlagen: PV-Anlagen, Speicher, BHKWs, mit Betrieb und Zähler

## Technischer Aufbau

| Baustein | Dienst | Aufgabe |
| --- | --- | --- |
| App | Webseite (PWA), gehostet über GitHub Pages, später eigene Domain | Erfassen und Anzeigen am Handy und PC, auch ohne Netz |
| Daten | Supabase, Region Irland eu-west-1 (kostenloser Tarif, siehe Entscheidungen) | Anmeldung mit Zwei-Faktor, Datenbank, Belege als PDF (privater Speicher), tägliche Sicherung |
| Code | GitHub, öffentliches Repository `betriebs-app` | jede Fassung bleibt |
| Waage (später) | Programm auf einem Kleinrechner an der Waage | liest Gewicht und Alibi-Nummer der geeichten Fuhrwerkswaage, schreibt in die Datenbank |
| Datensammler Biogasanlage (später) | Industrie-Kleinrechner im Schaltschrank, USV, Kabel | liest BHKWs, Speicher, PV und Zähler nur lesend; puffert ohne Netz und sendet nach; Lebenszeichen jede Minute, sonst Alarm aufs Handy |

Für die Biogasanlage kein Home Assistant und keine NAS. Ausnahme „Energie Zuhause“: Das ist der bestehende Home Assistant auf der NAS daheim; er wirft seine Werte in Supabase ein, die App liest sie dort (siehe Entscheidungen). Der Browser kann Geräte nicht direkt abfragen (CORS), deshalb holt ein Programm vor Ort die Werte ab und schreibt sie in die Datenbank.

## Module und Reihenfolge

Ein Modul nach dem anderen. Fertig ist es erst, wenn es im Alltag benutzt wird.

1. **Fundament:** Anmeldung mit Zwei-Faktor, Betriebe, Rollen, Stammdaten, Nummernkreise, Protokoll.
2. **Getreidelager:** Wareneingang, Warenausgang, Bestand je Lagerort und Partie, Bioland-Warenfluss.
3. **Biogas:** Einsatzstofftagebuch aus denselben Bewegungen, Gärrestabgabe.
4. **Maschinen und LKW:** Vermietungen und Einsätze je Maschine, LKW-Fahrten für fremde Auftraggeber, Belege zwischen den Betrieben.
5. **Energie:** Live-Ansicht und Auswertung von BHKWs, Speicher, PV und Zählern nach Tag, Monat und Jahr; Monatswerte je Anlage und Betrieb.
6. **Abläufe und Wartung:** Checklisten, Fälligkeiten, QR-Codes an Anlagenteilen mit Erklärvideos.
7. **Auswertung und Export:** DATEV, Umweltgutachter, Öko-Kontrolle, Steuerberater.

## Feste Regeln

- Nichts wird gelöscht, nur storniert. Ein falscher Beleg bekommt Stornovermerk und Nachfolger.
- Jede Zeile trägt, wer sie wann angelegt und geändert hat.
- Jede Bewegung gehört genau einem Betrieb. Zwischen zwei Betrieben gibt es immer einen Beleg.
- Bestand wird nie eingetippt. Inventur = eigene Korrekturbewegung mit Begründung.
- Gewichte kommen von der geeichten Fuhrwerkswaage: Gewicht und Alibi-Nummer zusammen, nie verändert. Handeingaben stehen sichtbar als „manuell“ auf dem Beleg (Eichrecht).
- Bio-Status hängt an jeder Partie. Bio und konventionell im selben Lagerort → Warnung.
- Rechte stehen in der Datenbank (Row Level Security), nicht nur in der App.
- Handy zuerst, offline-fähig. Der PC ist für Auswertungen.

## Sicherheit

- Zwei-Faktor für jedes Konto. Selbstregistrierung aus, Konten legt nur Christian an; neue Konten starten gesperrt.
- Nur der öffentliche Supabase-Schlüssel (anon) steht im Code. Der Hauptschlüssel nie im Repository, nie im Chat.
- Das Repository ist öffentlich: Code und Konzept darf jeder lesen. Deshalb nie Betriebsdaten, Personendaten, Passwörter oder Schlüssel (außer anon) ins Repository. Alle Daten liegen nur in Supabase.
- GitHub Pages liefert jede Datei aus: Interne Dateien in Ordner mit Unterstrich, `_config.yml` schließt `*.md` aus.
- Fehlermeldungen zeigen immer den Originaltext von Server oder Gerät.

## Offene Fragen

- Wer benutzt die App: Christian, Carolin, Mitarbeiter, Fahrer? (Rollen so anlegen, dass später welche dazukommen.)
- Welche Fuhrwerkswaage (Hersteller, Anzeige), welche Schnittstelle (RS232 oder Netzwerk)?
- Gibt es eine getrennte Leseschnittstelle zu den Daten der Fernwirktechnik? (Gespräch mit dem Programmierer am 21.10.2026)
- Wie ist die Biogasanlage (ca. 1 km vom Büro) angebunden, gibt es dort Internet?

## Entscheidungen

- 2026-10-20: Grundkonzept festgelegt (Mehrbetrieb, Warenbewegung als Kern, Reihenfolge der Module).
- 2026-10-20: Kein Home Assistant; Energie-Anzeige in der App, Daten über eigenen Datensammler vor Ort.
- 2026-10-20: v1 = leeres Gerüst (PWA mit Manifest und Service-Worker, offline-fähig, `_config.yml` schließt `*.md` aus). Bei jeder neuen Version die Nummer in `index.html` (Fußzeile) und `VERSION` in `sw.js` hochzählen, sonst holen die Handys die neuen Dateien nicht.
- 2026-10-20: Repository öffentlich statt privat, damit GitHub Pages kostenlos bleibt (privat bräuchte GitHub Pro). Christian ist einverstanden, dass Code und Konzept lesbar sind; Daten bleiben ausschließlich in Supabase.
- 2026-10-20: v1 online unter https://christianaumeier.github.io/betriebs-app/ (GitHub Pages, Branch main, root). Von Christian am Handy geprüft: Installation und Start im Flugmodus klappen. v1 ist fertig.
- Lehre: Der eingebaute Browser von Claude Code lädt keine Service-Worker. Offline-Tests deshalb in einem echten Browser (Edge) machen.
- 2026-10-20: Christian sieht die App als Dach mit vielen Bereichen, die nach und nach dazukommen. Startseite mit Kacheln in dieser Reihenfolge: Energie Biogasanlage, Getreidelager, Wartung Maschinen, Bahnschwellen, Wartung Biogasanlage, Energie Zuhause. Welcher Bereich zuerst Inhalt bekommt, entscheidet Christian. Die Reihenfolge unter „Module und Reihenfolge“ ist damit nicht mehr fest. Beispiele wie Mais-Lieferungen an die Biogasanlage interessieren derzeit nicht.
- 2026-10-20: „Energie Zuhause“ öffnet vorerst nur den Home Assistant (http://192.168.178.100:8123, nur im WLAN daheim erreichbar). Werte direkt in der App anzeigen: vielleicht später. Damit ist „Kein Home Assistant“ für den Bereich Zuhause aufgehoben.
- 2026-10-20: v2 = Startseite mit Kacheln. Die Bereiche stehen als Liste `BEREICHE` in `index.html`; Unterseiten laufen über Adressen mit `#` (z. B. `#getreidelager`), so funktionieren sie auch offline ohne zusätzliche Dateien.
- 2026-10-20: Home Assistant von unterwegs über VPN (WireGuard) der FRITZ!Box 7590 AX (MyFRITZ!-Adresse eingerichtet, Internetzugriff auf die FRITZ!Box bleibt aus), auf dem iPhone mit der WireGuard-App, Tunnel „Zuhause“. An NAS und Home Assistant wurde nichts geändert. Christian hat es ohne WLAN getestet: klappt. Nicht gewählt: Nabu Casa (kostet), Home Assistant direkt ins Internet (riskant).
- Hinweis: Safari auf dem iPhone kann die Home-Assistant-Anmeldung nach ca. einer Woche ohne Nutzung vergessen. Dauerhafte Lösung: offizielle Home-Assistant-App; die Kachel könnte dann direkt diese App öffnen (noch offen).
- 2026-10-20: Christian will die Home-Assistant-Oberfläche nicht mehr benutzen. Neuer Weg: Der Home Assistant liefert nur noch Daten, Anzeige und Bedienung laufen komplett über die Betriebs-App. Weil die App unter https läuft und der Home Assistant nur http spricht, darf die App ihn nicht direkt abfragen. Deshalb Supabase als „Briefkasten“: Home Assistant schreibt die Werte etwa alle 30 s nach Supabase, die App liest sie dort; Schaltbefehle (Wallbox „Winterladen“, „Volle Ladung erzwingen“) legt die App in Supabase ab, der Home Assistant holt sie ab. Funktioniert ohne VPN. Echte Werte erst nach Anmeldung mit Zwei-Faktor. Reihenfolge: 1. Darstellung mit Beispielwerten, 2. Supabase-Konto, 3. Anmeldung, 4. Home Assistant sendet Werte, 5. Schalten.
- 2026-10-20: v3 = neue Ansicht „Energie Zuhause“ (Dateien `energie-zuhause.js` und `.css`) mit Beispielwerten: Stromfluss-Bild (Solar, Haus, Einspeisung/Bezug, Speicher, Wallbox, mit fließenden Linien), Heute-Werte, Speicher-Balken, Wallbox-Schalter (noch gesperrt), Knopf „Home Assistant öffnen“. Die Kachel öffnet jetzt diese Ansicht statt des Home Assistant. Im Bild ist Platz für ein Foto des Hauses (Konstante `FOTO`). Achtung: Das Repository ist öffentlich, ein Foto dort wäre für jeden abrufbar. Vor dem Einbau mit Christian klären (sonst später privat über Supabase laden).
- 2026-10-20: Supabase eingerichtet. Organisation „Aumeier“ (Free), Projekt `betriebs-app`. Projekt-Adresse `https://trwazyqryqdjbfggaufd.supabase.co`, öffentlicher Schlüssel (publishable, darf in den Code) `sb_publishable_9zKcwyfgNlg19tYQDpivLQ_4j_JkxOc`. Beim Anlegen gewählt: Data API an, „Automatically expose new tables“ aus, „Enable automatic RLS“ an, also ist jede neue Tabelle zunächst verschlossen. Datenbank-Kennwort hat nur Christian. Secret key und service_role nie in Code oder Chat.
- 2026-10-20: Region: Ein erstes Projekt landete bei „Europe“ automatisch in London (eu-west-2) und wurde gelöscht. Eine bestimmte Region wie Frankfurt bietet Supabase im kostenlosen Tarif nicht mehr an (nur mit Pro). Christian hat sich bewusst für kostenlos und „Europe“ entschieden. Ergebnis: Region **eu-west-1, Irland** (EU-Mitglied, Daten innerhalb der EU). Die Angabe „Region Frankfurt“ oben unter „Technischer Aufbau“ gilt damit nicht. Falls ein Prüfer später Deutschland verlangt: Umzug auf Pro möglich.
- 2026-10-20: Selbstregistrierung in Supabase ausgeschaltet („Allow new users to sign up“ aus). Geprüft: Ein Registrierungsversuch mit dem öffentlichen Schlüssel wird abgelehnt (`signup_disabled`).
- 2026-10-20: Christian wollte statt Zwei-Faktor lieber Face ID. Lösung: Zwei-Faktor bleibt (E-Mail + Kennwort + 6-stelliger Code, TOTP), aber Kennwort und Code liegen in der iPhone-„Passwörter“-App und werden nach Face ID automatisch eingesetzt; am PC über iCloud für Windows. Echte Passkeys (nur Face ID) bietet Supabase seit Mai 2026 erst als Beta; nachrüsten, wenn fertig.
- 2026-10-20: v4 = Anmeldung. Die ganze App ist erst nach Kennwort + Code sichtbar (`anmeldung.js`, `anmeldung.css`). Erstanmeldung führt durch die Einrichtung des Codes (Knopf mit `otpauth://`-Link für die Passwörter-App, QR-Code für den PC). Startseite unten: angemeldet als …, „Kennwort ändern“ (iPhone schlägt sicheres Kennwort vor), „Abmelden“. Supabase-Bibliothek liegt fest im Projekt: `lib/supabase-2.117.2.js` (damit die App offline startet). Ohne Netz öffnet sich die App, wenn auf dem Gerät eine Anmeldung mit Code gespeichert ist; ohne gespeicherte Anmeldung erscheint der Hinweis, dass Anmelden nur mit Netz geht.
- Lehre (v5): Beim Wechsel zur Passwörter-App kann iOS die App neu laden. Früher wurde dann ein neuer Code-Generator erzeugt, und der gespeicherte Code passte nicht mehr. Jetzt merkt sich die App die angefangene Einrichtung (localStorage `betriebsapp-code-einrichtung`, wird nach Abschluss oder beim Abmelden gelöscht). Außerdem: Das erste Konto war nicht angelegt („E-Mail oder Kennwort falsch“). Bei Anmeldeproblemen zuerst die Benutzerliste in Supabase prüfen.
- 2026-10-22: Anmeldung (v5) von Christian am iPhone abgenommen. Kennwort und Bestätigungscode liegen in der Passwörter-App im Eintrag „GitHub Pages“ (Website christianaumeier.github.io); nicht verwechseln mit dem Eintrag „GitHub“ (github.com). Zuverlässigster Weg zur Code-Einrichtung: im Eintrag „Bearbeiten“ → „Bestätigungscode einrichten“ → „Einrichtungsschlüssel eingeben“ (der `otpauth`-Knopf zeigte den Eintrag ausgegraut).
- Regel: Die Anmeldeprüfung in der App ist nur Bedienkomfort. Der eigentliche Schutz sind die Rechte in der Datenbank: Jede Tabelle bekommt RLS-Regeln, die eine Anmeldung mit Code verlangen (`(auth.jwt() ->> 'aal') = 'aal2'`).
- Konten anlegen: Christian im Supabase-Dashboard unter Authentication → Users → „Add user“ → „Create new user“, mit „Auto Confirm User“. Vorläufiges Kennwort, das danach in der App über „Kennwort ändern“ ersetzt wird. E-Mails verschickt Supabase im kostenlosen Tarif nur an Mitglieder der Organisation; für Einladungen an Mitarbeiter später eigenen Mailversand (SMTP) einrichten. Fotos vom iPhone kommen über iCloud für Windows in `C:\Users\Christian\Pictures\iCloud Photos\Photos` an (Format HEIC).
- 2026-10-22: Briefkasten „Energie Zuhause“ in Betrieb (Datenbank-Änderungen stehen in `supabase/`, z. B. `001_energie_zuhause.sql`, als Migration angewendet):
  - Tabelle `public.energie_zuhause` mit genau einer Zeile: `werte` (jsonb), `tag`, `tagesstart` (Zählerstände zu Tagesbeginn, deutsche Zeit), `aktualisiert_am`. Lesen nur angemeldet mit Code (aal2); ohne Anmeldung verweigert (geprüft).
  - Schreiben nur über die Funktion `ha_melden(p_werte)` (`/rest/v1/rpc/ha_melden`, öffentlicher Schlüssel plus Kopfzeile `x-ha-schluessel`). Ohne oder mit falschem Schlüssel: Fehler 42501 (geprüft). Die Prüfsumme liegt in `intern.schluessel` (Name `homeassistant`), der Schlüssel selbst nur in der `secrets.yaml` als `supabase_ha_schluessel`. Neuer Schlüssel: lokal erzeugen, in `secrets.yaml` ersetzen, neue Prüfsumme eintragen.
  - Home Assistant: `rest_command.supabase_energie_melden` in `configuration.yaml`, Automation „Betriebs-App: Werte an Supabase“ (`automations.yaml`, alle 30 s). Eingespielt mit `rest_command.reload` und `automation.reload`, ohne Neustart. Der HA-Ordner ist ein eigenes Git-Repository; vor jeder Änderung den Stand committen.
  - Werte in `werte`: `pv_w`, `haus_w`, `netz_w` (negativ = Einspeisung), `speicher_w` (positiv = lädt; im HA umgekehrt, deshalb mit Minus), `speicher_prozent`, `wallbox_w`, `wallbox_status`, `winterladen`, `volle_ladung`, `erzeugung_kwh_gesamt`, `bezug_kwh_gesamt`, `einspeisung_kwh_gesamt`. Was im HA nicht verfügbar ist, kommt als null.
- 2026-10-22: v6 = „Energie Zuhause“ zeigt echte Werte. Die App liest die Zeile alle 30 s, solange die Ansicht offen und sichtbar ist, zeigt „Stand: vor …“ und eine Warnung, wenn die Werte älter als 5 Minuten sind. Heute-Werte = Zählerstand jetzt minus `tagesstart`; selbst verbraucht = (erzeugt − eingespeist) / erzeugt. Wallbox-Schalter zeigen den echten Zustand, bleiben aber gesperrt (Schalten kommt später). Von Christian am iPhone abgenommen: echte Werte sichtbar. v6 ist fertig.
- 2026-10-22: v7 = Foto von Christians Auto (weißer Mercedes EQV) im Stromfluss-Bild rechts neben dem Haus, über der Wallbox-Anzeige. Eine gezeichnete Version gefiel Christian nicht („sieht furchtbar aus“), er will das echte Foto. Das Foto ist ein Werbebild von Mercedes und liegt deshalb nicht im öffentlichen Repository, sondern in der Tabelle `public.bilder` (Name `auto`, Base64, nur angemeldet mit Code lesbar; `supabase/002_bilder.sql`). Die App merkt es sich im Gerät (localStorage `betriebsapp-bild-auto`). Der Hintergrund wurde im Browser freigestellt (Canvas: Umriss von Hand plus Flutfüllung des hellen Hintergrunds), 600 × 310 px WebP mit Transparenz. Bilder hochladen: Es gibt keine dauerhafte Schreibfunktion. Claude legt kurz eine Hilfsfunktion an (geschützt mit dem Home-Assistant-Schlüssel), lädt vom PC hoch und löscht sie gleich wieder. Von Christian am iPhone abgenommen, v7 ist fertig.
- Lehre: Bei Bild-Wünschen genau nachfragen oder vorher zeigen, *wo* das Bild hin soll (Christian meinte das dunkle Stromfluss-Bild, nicht die Wallbox-Karte).
- 2026-10-23: Growatt-Zugang repariert: Der Token im Home Assistant hatte einen Tippfehler. Christian hat den richtigen Token im Chat genannt (seine Entscheidung). Er liegt jetzt in der `secrets.yaml` (`growatt_token`) und im Supabase Vault (Name `growatt_token`), nie im Repository. Growatt-Konto: Anlagen „Stockhalle“ (4 × MID 30KTL3-X, je 30 kW, Volleinspeisung) und „Eigenverbrauch“ (Wohnhaus 2, MID 20KTL3-X). Growatt-API drosselt bei Abfragen im Abstand unter etwa 1 Minute (`code 102 FREQUENTLY_ACCESS`).
- 2026-10-23: Supabase holt die Growatt-Werte selbst ab, ohne Home Assistant und NAS (`supabase/005_pv_growatt.sql`, vorher 003 `http`/`pg_cron`, 004 `pg_net`). pg_cron schickt zur Minute 0, 5, 10 … die Anfrage (`intern.growatt_senden`, über pg_net), eine Minute später wertet `intern.growatt_verarbeiten` die Antwort aus. Tabellen: `pv_wechselrichter` (Stammdaten: Seriennummer, Anlage 1–4, Name laut Zählerschild, Zähler), `pv_live` (letzter Stand inkl. Roh-Antwort), `pv_tag` (Tageswerte, Grundlage für spätere Auswertungen und die Prüfung der Einspeise-Abrechnungen), `pv_abruf` (letzter Erfolg, Fehler mit Originaltext). Lesen nur mit Anmeldung + Code. Lehre: Die Erweiterung `http` scheitert bei POST an Growatt mit einem SSL-Fehler, `pg_net` geht; Growatt akzeptiert die Parameter auch in der Adresse mit leerem JSON-Inhalt.
- 2026-10-23: v8 = neue Kachel „PV Stockhalle“ (`pv-stockhalle.js`, `.css`): Gesamtleistung und heute erzeugt, je Anlage Leistung, heute, gesamt, Balken (Anteil an 30 kW), „gemeldet vor …“. Reihenfolge wie an der Wand von links: Anlage 4, 3, 2, 1. Warnungen nur tagsüber (eine Anlage ≥ 1 kW): Anlage meldet länger als 60 min nicht, oder liefert unter 60 % der anderen; außerdem, wenn der letzte Abruf älter als 15 min ist. Aktualisiert jede Minute, solange die Ansicht offen ist. Von Christian am iPhone abgenommen, v8 ist fertig.
- 2026-10-23: Störungsmeldungen mit zwei Kategorien, von Christian so gewünscht: **wichtig** = Push-Mitteilung aufs Handy (einmal beim Auftreten, einmal wenn behoben) plus Meldung in der App; **hinweis** = nur Meldung in der App (Leiste oben auf der Startseite). WhatsApp über CallMeBot war gewünscht, ging aber nicht (Dienst nimmt gerade niemanden auf); stattdessen Web-Push direkt aus der App (kostenlos, keine Fremd-App; am iPhone nur in der App vom Home-Bildschirm, ab iOS 16.4).
  - Datenbank (`supabase/006_stoerungen_push.sql`, `007`): Tabelle `stoerungen` (offen = `behoben_am` leer, je `schluessel` nur eine offene), `push_abos` (ein Eintrag je Gerät). `intern.stoerungen_pruefen` läuft per pg_cron zur Minute 2, 7, 12 … Regeln: Stockhallen-Anlage tagsüber > 60 min stumm → wichtig; < 60 % der anderen → hinweis, nach 60 min wichtig; Growatt-Abruf > 15 min kaputt → hinweis, > 2 h wichtig; Home Assistant > 5 min stumm → hinweis, > 30 min wichtig; Wohnhaus 2 > 1 Tag stumm → hinweis. „Tagsüber“ = eine Stockhallen-Anlage hat in den letzten 20 min ≥ 1 kW gemeldet; nachts werden Stockhallen-Störungen weder geöffnet noch geschlossen.
  - Versand: Edge Function `push-senden` (`supabase/functions/push-senden/index.ts`, verify_jwt aus, npm:web-push). Die Datenbank ruft sie über pg_net mit dem Geheimnis `push_ausloeser` auf; Schlüssel `vapid_privat`, `vapid_oeffentlich`, `push_ausloeser` liegen im Vault, die Funktion holt sie über `public.push_geheimnisse()` (nur service_role). Der öffentliche VAPID-Schlüssel steht in `meldungen.js`. Ungültige Geräte (404/410) löscht die Funktion selbst. Test geprüft mit Probe-Gerät (Versand ok), echter Test am iPhone über den Knopf „Testmitteilung senden“.
  - Lehre: Tabellen, die eine Edge Function lesen soll, brauchen ausdrücklich Rechte für service_role (007).
- 2026-10-23: v9 = Meldungsleiste auf der Startseite (`meldungen.js`, `.css`) und Karte „Mitteilungen bei wichtigen Störungen“ (erlauben, Testmitteilung, ausschalten). Service Worker zeigt Push-Mitteilungen und öffnet beim Antippen die App.
- 2026-10-23: Testmitteilung am iPhone angekommen. Christian will, dass Mitteilungen nicht von selbst verschwinden: Am iPhone geht das nur über Einstellungen → Mitteilungen → „Betrieb Aumeier“ → Banner-Stil „Dauerhaft“ (die App darf das dort nicht bestimmen); am PC sorgt `requireInteraction` dafür.
- 2026-10-23: v10 = Knopf „Gelesen“: Wichtige Störungen bleiben in der Meldungsleiste stehen, bis jemand „Gelesen“ tippt, auch wenn sie schon behoben sind; gespeichert wird wer und wann (`gelesen_am`, `gelesen_email`, `supabase/008_stoerungen_gelesen.sql`, RPC `stoerung_gelesen`). Hinweise haben keinen Knopf und verschwinden, wenn sie behoben sind. Christian: v10 am iPhone, Banner-Stil „Dauerhaft“ eingestellt (23.10.2026).
- 2026-10-23: Ladezustand des Autos (Mercedes EQV). Die Wallbox kennt ihn nicht, nur Mercedes me. Im Home Assistant die Bastler-Einbindung „MercedesME 2020“ (mbapi2020, v0.43.0, von GitHub, Prüfsumme kontrolliert) unter `custom_components/mbapi2020`. Lief auf HA 2024.6.1 erst nach einer kleinen Anpassung in `const.py` (Ersatz für `UnitOfEnergyDistance`, bei Updates der Einbindung neu setzen). Christian hat sich mit seinem **Hauptkonto** angemeldet (seine Entscheidung; Mitbenutzer-Konto ging nur per QR-Code mit zweitem Gerät; Risiko: Mercedes bremst bei vielen Abfragen auch die Mercedes-App). Zusätzliche Werte im Briefkasten: `auto_soc`, `auto_soc_ziel`, `auto_reichweite_km`, `auto_reichweite_max_km` (beide letzten kommen als Text), `auto_laedt`, `auto_ladeende` (ISO mit Zone), `auto_stand` (UTC ohne Zone). Lehre: Datums-Attribute im HA-Template immer mit `| string` umwandeln, sonst scheitert `tojson`, und der ganze Briefkasten bekommt nichts mehr.
- 2026-10-23: v11 = Karte „Auto“ in „Energie Zuhause“ (Balken, Ladeziel, Reichweite, „lädt, fertig ca. …“, Stand vom Auto) und „Auto … %“ an der Wallbox im Stromfluss-Bild. Von Christian am iPhone abgenommen, v11 ist fertig.
- 2026-10-23: Erste Richtung App → Home Assistant: **„Immer laden bis … %“** (Mindestladung), von Christian so gewünscht, **ersetzt „Winterladen“** (100 % = immer voll laden; Winterladen ist im HA ausgeschaltet, die alte Automatik bleibt nur liegen). Liefert Mercedes keinen Ladezustand, gilt das Auto als leer (Christians Entscheidung), also wird voll geladen. Startwert 100 %, damit sich beim Umstellen nichts änderte.
  - Supabase (`supabase/009_einstellungen.sql`): Tabelle `einstellungen` (Name → Wert), RPC `einstellung_setzen` (nur angemeldet mit Code, prüft Name und 0–100), RPC `ha_einstellungen` (mit dem Home-Assistant-Schlüssel).
  - Home Assistant: REST-Sensor „Betriebs-App Einstellungen“ holt jede Minute ab, Automatik „Betriebs-App: Einstellungen übernehmen“ schreibt in `input_number.wallbox_mindest_soc`. `binary_sensor.wallbox_mindestladung_aktiv` = Wert > 0 und Auto darunter (oder unbekannt). Automatik „Wallbox Mindestladung“ lädt dann alle 2 min mit 16 A; die Überschuss-Automatik pausiert solange. „Volle Ladung erzwingen“ hat Vorrang. Im Briefkasten zusätzlich `mindest_soc` und `mindestladung_aktiv`, damit die App zeigt, was im HA wirklich gilt. Eingespielt per Neuladen (input_number, rest, template, automation), ohne Neustart. Geprüft: nach Abschalten von Winterladen lädt die Wallbox weiter mit 16 A über die neue Automatik.
- 2026-10-23: v12 = Feld „Immer laden bis“ mit „Speichern“ in der Wallbox-Karte, darunter Zustand („Lädt voll bis 50 % …“, „50 % erreicht: lädt nur mit Überschuss“, „Wird übernommen …“). Das Feld wird einmal gebaut; während jemand tippt, wartet das Neuzeichnen.
- 2026-10-23: v12 von Christian am iPhone abgenommen (Wert gespeichert, HA hat übernommen). Hinweis: Der REST-Sensor holt den Wert mit bis zu etwa 2 Minuten Verzögerung ab; die App zeigt „Wird übernommen …“, bis der HA ihn meldet.
- 2026-10-23: Zweites Konto für Christians Frau Carolin angelegt (von Christian im Supabase-Dashboard, Organisation „Aumeier“; Lehre: Christian war zuerst in einer zweiten, leeren Supabase-Organisation „betriebs-app“ unter einem anderen Login, dort nichts anlegen). Sie hat die App auf dem Home-Bildschirm, Code in der Passwörter-App (Eintrag heißt auch bei ihr „GitHub Pages“), eigenes Kennwort, Mitteilungen erlaubt. Beide Konten sehen und dürfen alles; eigene Rechte pro Person gibt es noch nicht.
- Später gewünscht: Auswertungen nach Tag, Monat, Jahr je Anlage; Prüfung der Einspeise-Abrechnungen (Abrechnungs-PDFs gegen Zähler und `pv_tag`). DATEV Unternehmen online: keine Schnittstelle für uns (nur für DATEV-Partner), Belege nur über Export-Dateien.
- Hinweis: Der Supabase-Sicherheitscheck meldet `ha_melden` als „für jeden aufrufbar“. Das ist gewollt, die Funktion prüft den Schlüssel selbst. Ebenso gemeldet: `rls_auto_enable` (legt Supabase selbst an) und „Leaked Password Protection“ aus.
- 2026-10-24: Rollen eingeführt (`supabase/010_stempeln.sql`): Tabelle `personen` (Name, `rolle` chef/mitarbeiter, `stempelt`). Christian und Carolin sind chef und stempeln nicht. Neue Konten bekommen per Trigger auf `auth.users` automatisch `mitarbeiter` (Name vorläufig aus der E-Mail, danach per SQL richtig setzen). `public.ist_chef()` (mit Code angemeldet und chef). Alle bisherigen Tabellen (Energie, PV, Störungen, Einstellungen, Bilder) sind ab jetzt nur für chef lesbar, die schreibenden Funktionen (`push_abo_speichern`, `push_test`, `stoerung_gelesen`, `einstellung_setzen`) ebenso. Mitarbeiter bekommen deshalb auch keine Störungs-Mitteilungen. Die App holt die Rolle über `rpc/mein_profil` und merkt sie sich im Gerät (localStorage `betriebsapp-profil`, wird beim Abmelden gelöscht).
- 2026-10-24: v13 = Kachel „Stempeln“ (`stempeln.js`, `.css`), so von Christian gewünscht: unauffälliger Name, weil das Repository öffentlich ist (Zeiten selbst liegen nur in Supabase). Stempeln sollen 3 Mitarbeiter und 6 Minijobber, alle mit eigenem Smartphone (Jürgen Ungefug nicht, er ist bei Carolin angestellt). Keine Sollstunden, kein Standort, keine Pausen-Warnungen.
  - Mitarbeiter sehen nach der Anmeldung nur „Stempeln“: Start, Pause, Weiter, Stopp (Zeit setzt der Server, `rpc/stempeln` prüft die Reihenfolge), Formular „Zeit nachtragen“ mit Grund (`rpc/stempel_nachtragen`, Status `offen`), eigene Zeiten des Monats.
  - Chef sieht: Nachträge zur Freigabe (`rpc/nachtrag_entscheiden`), wer gerade arbeitet, Stunden je Person und Monat (aufklappbar je Tag), „Liste fürs Lohnbüro herunterladen“ (CSV für Excel), „Zeit eintragen“ für jeden (gilt sofort, wird als Nachtrag markiert).
  - Tabelle `stempel`: nie löschen oder ändern; Nachträge sind eigene Zeilen, Entscheidung mit wer/wann. Eine Schicht zählt zu dem Tag, an dem sie begann. Gezählt werden nur gültige Stempel; wartende Nachträge zählen für den Mitarbeiter schon beim Zustand der Knöpfe (wie in der Datenbank).
  - Geprüft (Test in der Datenbank, danach zurückgerollt): Mitarbeiter sieht keine Energie-/PV-Daten, nur die eigene Person und eigene Stempel, kann nicht doppelt starten, nicht selbst freigeben, nicht für andere nachtragen, die Wallbox nicht verstellen; Chef sieht alles und kann freigeben; ohne Code sieht niemand etwas. Ansicht für beide Rollen mit Beispieldaten im Browser geprüft.
  - Offen: Konten für die Mitarbeiter anlegen (E-Mail je Person nötig; Zwei-Faktor wie bei allen, am Android-Handy mit einer Code-App wie Google Authenticator), Erinnerung, wenn abends noch eingestempelt ist.
- Lehre (2026-10-24): In der Cloud-Sitzung am Handy fragt der Supabase-Connector bei Änderungen mit `drop` nach einer Bestätigung, die am Handy nicht erscheint (Zeitüberschreitung). Deshalb Migrationen ohne `drop` schreiben (z. B. `alter policy … using (…)` statt löschen und neu anlegen).
- 2026-10-24: v13 von Christian geprüft: alte Bereiche (Energie, PV) funktionieren weiter mit den neuen Rechten.
- 2026-10-24: v14 = Tätigkeit des Tages und Konten in der App anlegen, von Christian gewünscht (Tätigkeit: freier Text ohne Vorgaben, z. B. „meißeliert, Maschinen gewaschen“).
  - `supabase/011_taetigkeiten.sql`: Tabelle `taetigkeiten` (je Speichern eine neue Zeile, gezeigt wird die neueste je Person und Tag), `rpc/taetigkeit_speichern` (nur für sich, heute bis 62 Tage zurück), `rpc/person_bearbeiten` (Chef: Name, Stempeln an/aus; noch ohne Knopf in der App).
  - Mitarbeiter: Karte „Was hast du gemacht?“ (Tag + Text); nach Stopp erinnert die App, falls für heute nichts eingetragen ist. Tätigkeit steht in der Tagesliste, beim Chef ebenso und als Spalte „Tätigkeit“ in der Lohnbüro-Liste.
  - Edge Function `konto-anlegen` (`supabase/functions/konto-anlegen/index.ts`, verify_jwt aus, prüft selbst `ist_chef` mit der Anmeldung des Aufrufers): legt das Konto bestätigt an, setzt den Namen, gibt ein vorläufiges Kennwort zurück, das nur einmal in der App erscheint (nirgends gespeichert). In der App: Stempeln → „Konto für Mitarbeiter anlegen“. Geprüft: Aufruf ohne Anmeldung wird abgewiesen (401). Damit legt Christian Konten selbst am Handy an, ohne Supabase-Dashboard; Claude sieht die Kennwörter nie.
  - Chef-Ansicht: Formulare werden nur einmal gebaut, aufgeklappte Personen bleiben offen (sonst gingen Eingaben beim minütlichen Neuladen verloren).
  - Hinweis: Aus der Cloud-Sitzung sind supabase.co und github.io nicht erreichbar; Funktionstests über `net.http_post` in der Datenbank, Veröffentlichung über die Pages-Läufe auf GitHub prüfen.
- 2026-10-24: v15 = Texte: Hinweis „Noch keine Mitarbeiter angelegt …“ verweist auf das Formular; „already been registered“ wird übersetzt (Originaltext bleibt dahinter). Christian hatte fürs Testkonto seine Haupt-E-Mail genommen, die schon sein Chef-Konto ist; jede Adresse nur ein Konto.
- 2026-10-24: v16 = Mitarbeiter-Ansicht vereinfacht, so von Christian gewünscht („einfach nur einen Knopf Start, Uhrzeit automatisch; Zeiten ändern nur beim Nachtragen; was gemacht wurde erst vor dem Stopp, am Morgen weiß man das noch nicht“). Christian hatte die Chef-Ansicht mit dem Formular „Zeit eintragen“ für die Mitarbeiter-Ansicht gehalten.
  - Oben nur Zustand und Knöpfe. Die Karte „Was hast du gemacht?“ gibt es nicht mehr; beim Tippen auf Stopp erscheint das Feld „Was hast du heute gemacht?“ mit „Speichern und Stopp“ / „Abbrechen“ (steht schon etwas für den Tag, stempelt Stopp direkt).
  - `supabase/012_stopp_mit_taetigkeit.sql`: `rpc/stempeln` lehnt Stopp ab, solange für den Tag des Schicht-Starts keine Tätigkeit eingetragen ist (geprüft, zurückgerollt).
  - Nachtragen ist eingeklappt („Vergessen zu stempeln? Hier nachtragen“); beim Nachtragen eines Stopps fragt die App auch die Tätigkeit des Tages ab. Beim Chef heißt es eingeklappt „Zeit für jemanden eintragen“.
  - Datum-/Uhrzeit-Felder am iPhone nicht mehr abgeschnitten (`appearance: none`).
- 2026-10-24: v17. Christian will sich nicht als Mitarbeiter anmelden, sondern die Mitarbeiter-Ansicht nur sehen und ausprobieren.
  - Knopf „Mitarbeiter-Ansicht ausprobieren“ oben in der Chef-Ansicht: zeigt die echte Mitarbeiter-Ansicht mit Beispieltagen; Start/Pause/Weiter/Stopp/Tätigkeit/Nachtrag funktionieren, aber nur im Speicher des Geräts (`vorschauDb()` in `stempeln.js`, gleiche Regeln wie die Datenbank), nichts wird gespeichert. `zeigeMitarbeiter(ziel, db)` und `nachtragFormular(…, db)` nehmen dafür eine Datenquelle.
  - Fehler behoben: Die Personen-Zeilen im Monat ließen sich am iPhone nicht aufklappen (Safari klappt `<summary>` mit `display: flex` nicht auf). Jetzt `summary` als Block mit innerem `.zeile`, Pfeil ▸/▾.
  - Stopp ohne Pause ging schon immer (bei „arbeitet“ stehen Pause und Stopp nebeneinander). Nach Stopp kann am selben Tag wieder Start gedrückt werden; die Schichten zählen zum selben Tag, die Unterbrechung zählt nicht als Arbeitszeit, der Tag ist markiert („2× gestartet“). Beim zweiten Stopp wird die Tätigkeit nicht erneut abgefragt, weil für den Tag schon eine da ist.
  - Durchgeklickt im Browser (Chromium): Aufklappen, Vorschau mit Start → Pause → Weiter → Stopp mit Tätigkeit → zweiter Start → Stopp ohne Pause, Vorschau beenden.
- 2026-10-24: v18. Lehre: Christian sah v17 nicht, obwohl sie online war. GitHub Pages erlaubt dem Browser 10 Minuten Zwischenspeicher (max-age=600), und der Service Worker holte „aus dem Netz“ über diesen Zwischenspeicher. Jetzt holt `sw.js` die eigenen Dateien mit `cache: 'no-cache'` (Nachfrage beim Server, ob neu). Nach einer neuen Version die App am iPhone ganz schließen (nach oben wischen) und neu öffnen; unten muss die neue Nummer stehen.
