// Bereich „PV Stockhalle“: die vier Volleinspeise-Anlagen in der Stockhalle (Growatt MID 30KTL3-X).
// Supabase holt die Werte selbst alle 5 Minuten bei Growatt ab (supabase/005_pv_growatt.sql),
// die App liest die Tabellen pv_wechselrichter, pv_live und pv_abruf, solange die Ansicht offen ist.

(function () {
  const ABFRAGE_MS = 60000;          // Growatt liefert nur alle 5 Minuten neue Werte
  const STUMM_MIN = 60;              // so lange darf eine Anlage tagsüber schweigen
  const ABRUF_ALT_MIN = 15;          // so alt darf der letzte erfolgreiche Abruf sein
  const SONNE_W = 1000;              // ab dieser Leistung bei einer Anlage gilt „Sonne scheint“
  const SCHWACH_ANTEIL = 0.6;        // weniger als 60 % der anderen = auffällig
  const KWP = 120;                   // Anlagengröße Stockhalle (Growatt-Anlage „Stockhalle“, 4 × 30 kWp)

  function istZahl(x) { return typeof x === 'number' && isFinite(x); }
  function zahl(x, stellen) {
    if (!istZahl(x)) return '–';
    return x.toLocaleString('de-DE', { minimumFractionDigits: stellen, maximumFractionDigits: stellen });
  }
  function kw(w) { return istZahl(w) ? zahl(w / 1000, 1) + ' kW' : '–'; }
  function kwh(x, stellen) { return istZahl(x) ? zahl(x, stellen) + ' kWh' : '–'; }
  function el(tag, klasse, text) {
    const e = document.createElement(tag);
    if (klasse) e.className = klasse;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function vorWieLange(sek) {
    if (sek < 90) return 'vor ' + Math.max(0, Math.round(sek)) + ' Sekunden';
    if (sek < 90 * 60) return 'vor ' + Math.round(sek / 60) + ' Minuten';
    if (sek < 36 * 3600) return 'vor ' + Math.round(sek / 3600) + ' Stunden';
    return 'vor ' + Math.round(sek / 86400) + ' Tagen';
  }
  function datumZeit(d) {
    return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function heuteBerlin(d) {
    return d.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
  }
  function zahlOderNull(x) { return x === null || x === undefined ? null : Number(x); }
  // Heutiges Datum in deutscher Zeit als JJJJ-MM-TT (wie pv_tag.tag)
  function tagBerlin(d) {
    return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  }
  function tagText(iso) {
    const [j, m, t] = iso.split('-');
    return t + '.' + m + '.' + j;
  }

  // Tageswerte seit Jahresbeginn; Supabase liefert höchstens 1000 Zeilen je Anfrage, deshalb seitenweise
  async function tageswerteHolen(abTag) {
    const zeilen = [];
    for (let von = 0; ; von += 1000) {
      const r = await window.sb.from('pv_tag').select('sn, tag, kwh').gte('tag', abTag)
        .order('tag').order('sn').range(von, von + 999);
      if (r.error) throw r.error;
      zeilen.push(...(r.data || []));
      if (!r.data || r.data.length < 1000) return zeilen;
    }
  }

  // Ansicht öffnen: Daten holen, jede Minute neu holen; beim Verlassen hört alles auf.
  function zeigePvStockhalle(ziel) {
    const box = el('div', 'ph');
    const stand = el('div', 'ph-stand', 'Werte werden geladen …');
    const meldung = el('div', 'ph-meldungen');
    const inhalt = el('div', 'ph');
    box.append(stand, meldung, inhalt);
    ziel.replaceChildren(box);
    let laeuft = false;

    async function holen() {
      if (laeuft || !box.isConnected) return;
      laeuft = true;
      try {
        const [w, l, a, tage] = await Promise.all([
          window.sb.from('pv_wechselrichter').select('*').eq('anlage', 'Stockhalle').order('sortierung'),
          window.sb.from('pv_live').select('sn, gemeldet_am, leistung_w, heute_kwh, gesamt_kwh, temperatur, stick'),
          window.sb.from('pv_abruf').select('*').maybeSingle(),
          tageswerteHolen(tagBerlin(new Date()).slice(0, 4) + '-01-01')
        ]);
        if (!box.isConnected) return;
        const fehler = w.error || l.error || a.error;
        if (fehler) throw fehler;
        zeichnen(inhalt, meldung, stand, w.data || [], l.data || [], a.data, tage);
      } catch (e) {
        if (!box.isConnected) return;
        const text = (e && e.message) ? e.message + (e.code ? ' (' + e.code + ')' : '') : String(e);
        meldung.replaceChildren(el('div', 'ph-hinweis fehler', 'Werte konnten nicht geladen werden: ' + text));
        stand.textContent = '';
      } finally {
        laeuft = false;
      }
    }

    const abfrage = setInterval(() => {
      if (!box.isConnected) aufhoeren(); else if (!document.hidden) holen();
    }, ABFRAGE_MS);
    function sichtbar() { if (!document.hidden) holen(); }
    document.addEventListener('visibilitychange', sichtbar);
    function aufhoeren() {
      clearInterval(abfrage);
      document.removeEventListener('visibilitychange', sichtbar);
    }
    holen();
  }

  function zeichnen(inhalt, meldung, stand, wechselrichter, live, abruf, tage) {
    const jetzt = Date.now();
    const heute = heuteBerlin(new Date());
    const nachSn = {};
    live.forEach((x) => { nachSn[x.sn] = x; });

    // Je Anlage aufbereiten
    const anlagen = wechselrichter.map((w) => {
      const x = nachSn[w.sn] || {};
      const zeit = x.gemeldet_am ? new Date(x.gemeldet_am) : null;
      const alterMin = zeit ? (jetzt - zeit.getTime()) / 60000 : Infinity;
      const vonHeute = zeit && heuteBerlin(zeit) === heute;
      return {
        w, zeit, alterMin,
        aktuell: alterMin <= STUMM_MIN,
        leistung: alterMin <= STUMM_MIN ? zahlOderNull(x.leistung_w) : null,
        heuteKwh: vonHeute ? zahlOderNull(x.heute_kwh) : null,
        gesamtKwh: zahlOderNull(x.gesamt_kwh),
        stick: x.stick
      };
    });

    // Warnungen: nur tagsüber (wenn mindestens eine Anlage nennenswert Leistung bringt)
    const aktuelle = anlagen.filter((a) => a.aktuell && istZahl(a.leistung));
    const sonne = aktuelle.some((a) => a.leistung >= SONNE_W);
    const warnungen = [];
    anlagen.forEach((a) => {
      a.warnung = '';
      const titel = 'Anlage ' + a.w.nr + ' „' + a.w.name + '“';
      if (!a.zeit) {
        a.warnung = 'hat noch nie gemeldet';
      } else if (!a.aktuell && sonne) {
        a.warnung = 'meldet seit ' + datumZeit(a.zeit) + ' nicht';
      } else if (sonne && a.aktuell && istZahl(a.leistung)) {
        const andere = aktuelle.filter((b) => b !== a).map((b) => b.leistung);
        if (andere.length) {
          const mittel = andere.reduce((s, v) => s + v, 0) / andere.length;
          if (mittel >= SONNE_W && a.leistung < mittel * SCHWACH_ANTEIL) {
            a.warnung = 'liefert nur ' + Math.round(a.leistung / mittel * 100) + ' % der anderen';
          }
        }
      }
      if (a.warnung) warnungen.push(titel + ' ' + a.warnung + '.');
    });

    // Kopf: Stand des Abrufs und Fehler
    meldung.replaceChildren();
    if (abruf && abruf.letzter_erfolg) {
      const sek = (jetzt - new Date(abruf.letzter_erfolg).getTime()) / 1000;
      stand.textContent = 'Von Growatt abgerufen ' + vorWieLange(sek);
      stand.classList.toggle('alt', sek > ABRUF_ALT_MIN * 60);
      if (sek > ABRUF_ALT_MIN * 60) {
        meldung.append(el('div', 'ph-hinweis', 'Achtung: Der letzte erfolgreiche Abruf bei Growatt ist älter als ' + ABRUF_ALT_MIN + ' Minuten.'));
      }
    } else {
      stand.textContent = 'Noch kein Abruf bei Growatt.';
    }
    if (abruf && abruf.fehler) {
      meldung.append(el('div', 'ph-hinweis fehler', 'Letzter Abruf fehlgeschlagen: ' + abruf.fehler));
    }
    warnungen.forEach((t) => meldung.append(el('div', 'ph-hinweis', t)));

    const box = el('div', 'ph');

    // Gesamt
    const summeW = aktuelle.reduce((s, a) => s + a.leistung, 0);
    const heuteWerte = anlagen.map((a) => a.heuteKwh).filter(istZahl);
    const summeHeute = heuteWerte.reduce((s, v) => s + v, 0);
    const gesamt = el('div', 'ph-gesamt');
    [
      [aktuelle.length ? kw(summeW) : '–', 'Leistung jetzt'],
      [heuteWerte.length ? kwh(summeHeute, 1) : '–', 'heute erzeugt']
    ].forEach(([z, t]) => {
      const d = el('div');
      d.append(el('div', 'zahl', z), el('div', 'text', t));
      gesamt.append(d);
    });

    // Spezifischer Ertrag (kWh pro kWp): vergangene Tage aus pv_tag, heute wie oben aus den Live-Werten
    const heuteIso = tagBerlin(new Date());
    const monatAb = heuteIso.slice(0, 8) + '01';
    const jahrAb = heuteIso.slice(0, 5) + '01-01';
    const unsere = new Set(wechselrichter.map((x) => x.sn));
    const vorher = (tage || []).filter((t) => unsere.has(t.sn) && t.tag < heuteIso && istZahl(Number(t.kwh)));
    const summeAb = (ab) => vorher.filter((t) => t.tag >= ab).reduce((s, t) => s + Number(t.kwh), 0) + summeHeute;
    const ersterTag = vorher.length ? vorher[0].tag : heuteIso;
    const spez = el('div', 'ph-spez');
    spez.append(el('div', 'titel', 'kWh pro kWp (' + KWP + ' kWp)'));
    const spezWerte = el('div', 'werte');
    [
      [heuteWerte.length ? zahl(summeHeute / KWP, 2) : '–', 'heute'],
      [heuteWerte.length || vorher.length ? zahl(summeAb(monatAb) / KWP, 2) : '–', 'Monat'],
      [heuteWerte.length || vorher.length ? zahl(summeAb(jahrAb) / KWP, 2) : '–', 'Jahr']
    ].forEach(([z, t]) => {
      const d = el('div');
      d.append(el('div', 'zahl', z), el('div', 'text', t));
      spezWerte.append(d);
    });
    spez.append(spezWerte);
    if (ersterTag > monatAb || ersterTag > jahrAb) {
      spez.append(el('div', 'hinweis', 'Tageswerte erst ab ' + tagText(ersterTag) + ', '
        + (ersterTag > monatAb ? 'Monat und Jahr' : 'Jahr') + ' deshalb noch unvollständig.'));
    }
    gesamt.append(spez);
    box.append(gesamt);

    // Je Anlage eine Karte, Reihenfolge wie an der Wand von links: Anlage 4, 3, 2, 1
    const liste = el('div', 'ph-liste');
    anlagen.slice().sort((x, y) => (y.w.nr || 0) - (x.w.nr || 0)).forEach((a) => {
      const k = el('div', 'ph-anlage' + (a.warnung ? ' warnung' : ''));
      const kopf = el('div', 'kopf');
      const punkt = el('span', 'punkt ' + (a.warnung ? 'rot' : a.aktuell ? 'gruen' : 'grau'));
      kopf.append(punkt, el('span', 'nr', 'Anlage ' + a.w.nr), el('span', 'name', a.w.name));
      k.append(kopf);

      const werte = el('div', 'werte');
      [
        [kw(a.leistung), 'jetzt'],
        [kwh(a.heuteKwh, 1), 'heute'],
        [istZahl(a.gesamtKwh) ? zahl(a.gesamtKwh / 1000, 1) + ' MWh' : '–', 'gesamt']
      ].forEach(([z, t]) => {
        const d = el('div');
        d.append(el('div', 'zahl', z), el('div', 'text', t));
        werte.append(d);
      });
      k.append(werte);

      // Balken: Anteil an 30 kW Nennleistung
      if (istZahl(a.leistung) && a.w.kw) {
        const balken = el('div', 'ph-balken');
        const fuell = el('div');
        fuell.style.width = Math.max(0, Math.min(100, a.leistung / (a.w.kw * 1000) * 100)) + '%';
        balken.append(fuell);
        k.append(balken);
      }

      const fuss = a.warnung ? a.warnung.charAt(0).toUpperCase() + a.warnung.slice(1)
        : a.zeit ? 'Gemeldet ' + vorWieLange((jetzt - a.zeit.getTime()) / 1000) : '';
      k.append(el('div', 'fuss', fuss));
      liste.append(k);
    });
    box.append(liste);

    box.append(el('div', 'ph-fussnote',
      'Reihenfolge wie an der Wand von links (ab Zählerschrank). Werte von Growatt, sie liegen etwa 1 % über den Zählern im Schrank. Maßgeblich für die Abrechnung sind die Zähler.'));

    inhalt.replaceChildren(box);
  }

  window.zeigePvStockhalle = zeigePvStockhalle;
})();
