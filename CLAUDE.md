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
- 2026-10-22: v6 = „Energie Zuhause“ zeigt echte Werte. Die App liest die Zeile alle 30 s, solange die Ansicht offen und sichtbar ist, zeigt „Stand: vor …“ und eine Warnung, wenn die Werte älter als 5 Minuten sind. Heute-Werte = Zählerstand jetzt minus `tagesstart`; selbst verbraucht = (erzeugt − eingespeist) / erzeugt. Wallbox-Schalter zeigen den echten Zustand, bleiben aber gesperrt (Schalten kommt später).
- Hinweis: Der Supabase-Sicherheitscheck meldet `ha_melden` als „für jeden aufrufbar“. Das ist gewollt, die Funktion prüft den Schlüssel selbst. Ebenso gemeldet: `rls_auto_enable` (legt Supabase selbst an) und „Leaked Password Protection“ aus.
