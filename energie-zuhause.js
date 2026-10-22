// Bereich „Energie Zuhause“: Übersicht der PV-Anlage daheim.
// Die Werte liegen in Supabase (Tabelle energie_zuhause, eine Zeile). Der Home Assistant
// wirft sie alle 30 Sekunden ein, die App liest sie, solange die Ansicht offen ist.

(function () {
  // Vorzeichen in werte:
  // netz_w negativ = Einspeisung, positiv = Bezug; speicher_w positiv = lädt, negativ = entlädt.
  // Zählerstände *_kwh_gesamt; tagesstart = Zählerstände zu Tagesbeginn (deutsche Zeit).
  const ABFRAGE_MS = 30000;
  const ZU_ALT_S = 5 * 60;

  // Foto für den Hintergrund (später). Leer = gezeichnetes Haus.
  const FOTO = '';

  const HA_ADRESSE = 'http://192.168.178.100:8123';

  const FARBE = { pv: '#f5b301', netzAus: '#4aa3ff', netzEin: '#ff6b6b', speicher: '#2fd27a', wallbox: '#b38cff' };

  // Positionen im Bild (Breite 100, Höhe 90)
  const POS = { pv: [50, 12], haus: [50, 53], netz: [85, 32], speicher: [17, 77], wallbox: [83, 77] };

  function istZahl(x) { return typeof x === 'number' && isFinite(x); }
  function kw(w) {
    if (!istZahl(w)) return '–';
    return (Math.abs(w) / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' kW';
  }
  function zahl(x, stellen) {
    if (!istZahl(x)) return '–';
    return x.toLocaleString('de-DE', { minimumFractionDigits: stellen, maximumFractionDigits: stellen });
  }
  // Differenz Zählerstand jetzt minus Tagesbeginn (null, wenn etwas fehlt)
  function seitHeute(jetzt, start) {
    return istZahl(jetzt) && istZahl(start) ? Math.max(0, jetzt - start) : null;
  }
  function wallboxText(s) {
    if (!s) return '';
    return String(s).replace('Laedt', 'lädt');
  }
  function vorWieLange(sek) {
    if (sek < 5) return 'gerade eben';
    if (sek < 90) return 'vor ' + Math.round(sek) + ' Sekunden';
    if (sek < 90 * 60) return 'vor ' + Math.round(sek / 60) + ' Minuten';
    if (sek < 36 * 3600) return 'vor ' + Math.round(sek / 3600) + ' Stunden';
    return 'vor ' + Math.round(sek / 86400) + ' Tagen';
  }
  function el(tag, klasse, text) {
    const e = document.createElement(tag);
    if (klasse) e.className = klasse;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function chip(name, wert, extra, farbe, pos) {
    const c = el('div', 'ez-chip');
    c.style.left = pos[0] + '%';
    c.style.top = (pos[1] / 90 * 100) + '%';
    const w = el('span', 'wert', wert);
    if (farbe) w.style.color = farbe;
    c.append(w, el('span', 'name', name));
    if (extra) c.append(el('span', 'extra', extra));
    return c;
  }

  // Linie von a nach b; fliesst = Leistung > 50 W; rueck = Fluss läuft von b nach a
  function fluss(d, farbe, fliesst, rueck) {
    const ns = 'http://www.w3.org/2000/svg';
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    p.setAttribute('class', 'ez-fluss ' + (fliesst ? 'laeuft' + (rueck ? ' rueck' : '') : 'ruht'));
    if (fliesst) p.setAttribute('stroke', farbe);
    return p;
  }

  function hausZeichnung() {
    // Schlichte Linien-Zeichnung, nur solange kein Foto da ist
    return '' +
      '<defs><linearGradient id="ez-pv" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#3d6fa3"/><stop offset="1" stop-color="#1d3a5c"/></linearGradient></defs>' +
      '<polygon points="27,41 50,24 73,41" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.35)" stroke-width="0.5"/>' +
      '<polygon points="35,38 50,27.2 65,38" fill="url(#ez-pv)" stroke="rgba(255,255,255,0.45)" stroke-width="0.3"/>' +
      '<path d="M40,34.4 L60,34.4 M45,30.8 L55,30.8 M45,38 L50,27.2 L55,38" stroke="rgba(255,255,255,0.35)" stroke-width="0.25" fill="none"/>' +
      '<rect x="31" y="41" width="38" height="25" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.35)" stroke-width="0.5"/>' +
      '<line x1="10" y1="66" x2="90" y2="66" stroke="rgba(255,255,255,0.15)" stroke-width="0.4"/>';
  }

  // Ansicht öffnen: Zeile holen, alle 30 s neu holen, jede Sekunde „Stand“ fortschreiben.
  // Sobald die Ansicht verlassen wird (box nicht mehr im Dokument), hört alles auf.
  function zeigeEnergieZuhause(ziel) {
    const box = el('div', 'ez');
    const kopf = el('div', 'ez-kopf');
    const stand = el('div', 'ez-stand', 'Werte werden geladen …');
    const meldung = el('div');
    const inhalt = el('div', 'ez');
    kopf.append(stand, meldung);
    box.append(kopf, inhalt);
    ziel.replaceChildren(box);

    let zeit = null; // aktualisiert_am der zuletzt geholten Zeile
    let laeuft = false;

    function standZeigen() {
      if (!zeit) return;
      const sek = (Date.now() - zeit.getTime()) / 1000;
      stand.textContent = 'Stand: ' + vorWieLange(Math.max(0, sek));
      const alt = sek > ZU_ALT_S;
      stand.classList.toggle('alt', alt);
      const warnung = meldung.querySelector('.ez-hinweis.alt');
      if (alt && !warnung) {
        meldung.prepend(el('div', 'ez-hinweis alt',
          'Achtung: Die Werte sind älter als 5 Minuten. Der Home Assistant meldet gerade nichts.'));
      } else if (!alt && warnung) {
        warnung.remove();
      }
    }

    async function holen() {
      if (laeuft || !box.isConnected) return;
      laeuft = true;
      try {
        const { data, error } = await window.sb.from('energie_zuhause').select('*').single();
        if (!box.isConnected) return;
        meldung.querySelectorAll('.ez-hinweis.fehler').forEach((e) => e.remove());
        if (error) throw error;
        if (!data.aktualisiert_am) {
          stand.textContent = 'Der Home Assistant hat noch keine Werte gemeldet.';
          return;
        }
        zeit = new Date(data.aktualisiert_am);
        zeichnen(inhalt, data.werte || {}, data.tagesstart || {});
        standZeigen();
      } catch (e) {
        if (!box.isConnected) return;
        const text = (e && e.message) ? e.message + (e.code ? ' (' + e.code + ')' : '') : String(e);
        meldung.append(el('div', 'ez-hinweis fehler', 'Werte konnten nicht geladen werden: ' + text));
        if (!zeit) stand.textContent = '';
      } finally {
        laeuft = false;
      }
    }

    const abfrage = setInterval(() => { if (!box.isConnected) aufhoeren(); else if (!document.hidden) holen(); }, ABFRAGE_MS);
    const uhr = setInterval(() => { if (!box.isConnected) aufhoeren(); else standZeigen(); }, 1000);
    function sichtbar() { if (!document.hidden) holen(); }
    document.addEventListener('visibilitychange', sichtbar);
    function aufhoeren() {
      clearInterval(abfrage);
      clearInterval(uhr);
      document.removeEventListener('visibilitychange', sichtbar);
    }
    holen();
  }

  function zeichnen(ziel, v, start) {
    const box = el('div', 'ez');

    // --- Übersicht mit Stromfluss ---
    const bild = el('div', 'ez-bild' + (FOTO ? ' mit-foto' : ''));
    if (FOTO) bild.style.backgroundImage = 'url("' + FOTO + '")';

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 100 90');
    svg.setAttribute('aria-hidden', 'true');
    if (!FOTO) svg.innerHTML = hausZeichnung();

    const einspeisen = v.netz_w < 0;
    const netzFarbe = einspeisen ? FARBE.netzAus : FARBE.netzEin;
    svg.append(
      fluss('M50,17.5 L50,27', FARBE.pv, v.pv_w > 50, false),
      fluss('M69,47 Q78,46 82,37', netzFarbe, Math.abs(v.netz_w) > 50, !einspeisen),
      fluss('M33,63 Q24,64 19,71', FARBE.speicher, Math.abs(v.speicher_w) > 50, v.speicher_w < 0),
      fluss('M67,63 Q76,64 81,71', FARBE.wallbox, v.wallbox_w > 50, false)
    );
    bild.append(svg);

    bild.append(
      chip('Solar', kw(v.pv_w), null, FARBE.pv, POS.pv),
      chip('Haus', kw(v.haus_w), null, '#ffffff', POS.haus),
      chip(einspeisen ? 'Einspeisung' : 'Netzbezug', kw(v.netz_w), null, netzFarbe, POS.netz),
      chip('Speicher', zahl(v.speicher_prozent, 0) + ' %',
        Math.abs(v.speicher_w) > 50 ? (v.speicher_w > 0 ? 'lädt ' : 'entlädt ') + kw(v.speicher_w) : 'Ruhe',
        FARBE.speicher, POS.speicher),
      chip('Wallbox', v.wallbox_w > 50 ? kw(v.wallbox_w) : '–', wallboxText(v.wallbox_status), FARBE.wallbox, POS.wallbox)
    );
    box.append(bild);

    // --- Heute ---
    const heute = el('div', 'ez-karte');
    heute.append(el('h2', null, 'Heute'));
    const raster = el('div', 'ez-raster');
    const erzeugt = seitHeute(v.erzeugung_kwh_gesamt, start.erzeugung_kwh);
    const eingespeist = seitHeute(v.einspeisung_kwh_gesamt, start.einspeisung_kwh);
    const bezogen = seitHeute(v.bezug_kwh_gesamt, start.bezug_kwh);
    // selbst verbraucht = erzeugt − eingespeist, als Anteil an der Erzeugung
    const quote = istZahl(erzeugt) && istZahl(eingespeist) && erzeugt > 0
      ? Math.round(Math.max(0, erzeugt - eingespeist) / erzeugt * 100) : null;
    const kwh = (x) => istZahl(x) ? zahl(x, 1) + ' kWh' : '–';
    [
      [kwh(erzeugt), 'erzeugt'],
      [istZahl(quote) ? quote + ' %' : '–', 'selbst verbraucht'],
      [kwh(eingespeist), 'eingespeist'],
      [kwh(bezogen), 'aus dem Netz']
    ].forEach(([z, t]) => {
      const d = el('div');
      d.append(el('div', 'zahl', z), el('div', 'text', t));
      raster.append(d);
    });
    heute.append(raster);
    box.append(heute);

    // --- Speicher ---
    const sp = el('div', 'ez-karte');
    sp.append(el('h2', null, 'Speicher'));
    const balken = el('div', 'ez-balken');
    const fuell = el('div');
    fuell.style.width = Math.max(0, Math.min(100, v.speicher_prozent)) + '%';
    balken.append(fuell);
    sp.append(balken, el('div', 'ez-fussnote',
      zahl(v.speicher_prozent, 0) + ' % geladen · ' +
      (Math.abs(v.speicher_w) > 50 ? (v.speicher_w > 0 ? 'lädt mit ' : 'entlädt mit ') + kw(v.speicher_w) : 'in Ruhe')));
    box.append(sp);

    // --- Wallbox ---
    const wb = el('div', 'ez-karte');
    wb.append(el('h2', null, 'Wallbox'));
    [
      ['Winterladen', 'immer mit 16 A laden', v.winterladen],
      ['Volle Ladung erzwingen', 'einmal voll laden, dann wieder Überschuss', v.volle_ladung]
    ].forEach(([name, text, an]) => {
      const zeile = el('label', 'ez-schalter');
      const links = el('div');
      links.append(el('div', null, name), el('div', 'text', text));
      const s = document.createElement('input');
      s.type = 'checkbox';
      s.checked = an === true;
      s.disabled = true;
      zeile.append(links, s);
      wb.append(zeile);
    });
    wb.append(el('div', 'ez-fussnote', 'Schalten aus der App kommt in einem späteren Schritt.'));
    box.append(wb);

    // --- Home Assistant ---
    const ha = el('a', 'ez-knopf', 'Home Assistant öffnen');
    ha.href = HA_ADRESSE;
    ha.target = '_blank';
    ha.rel = 'noopener';
    box.append(ha);

    box.append(el('div', 'ez-fussnote', 'Solar = WH1 gemessen + WH2 geschätzt'));

    ziel.replaceChildren(box);
  }

  window.zeigeEnergieZuhause = zeigeEnergieZuhause;
})();
