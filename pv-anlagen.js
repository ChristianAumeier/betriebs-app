// Bereich „PV-Anlagen“: alle PV-Anlagen in einer Kachel (Christian, 07.11.2026: „du kannst alle PV-Anlagen
// in eine Kachel packen. Nenne die Anlagen: Stockhalle, BGA neu und BGA alt“). Ersetzt „PV Stockhalle“ (v8) und
// „PV Biogasanlage“ (v47).
// - Stockhalle: 4 × Growatt MID 30KTL3-X, 120 kWp, Supabase holt selbst ab (005): pv_wechselrichter, pv_live, pv_tag, pv_abruf
// - BGA neu (570 kWp) und BGA alt (108 kWp): Solar-Log Base 2000, gemeldet vom Büro-PC (032): pvbga_wechselrichter,
//   pvbga_live, pvbga_tag, pvbga_abruf
// Oben die Datumsleiste (pv-tag.js); heute mit Live-Werten und Warnungen, frühere Tage nur Tageswerte.
// Wechselrichter je Anlage zugeklappt, klappen bei einer Warnung von selbst auf.

(function () {
  const ABFRAGE_MS = 60000;
  const STUMM_MIN = 60;              // so lange darf ein Wechselrichter tagsüber schweigen
  const QUELLE_ALT_MIN = 15;         // so alt darf die letzte Abfrage/Meldung sein
  const SONNE_W_PRO_KWP = 20;        // ab 20 W je kWp im Schnitt einer Anlage gilt „Sonne scheint“
  const SCHWACH_ANTEIL = 0.6;        // weniger als 60 % der anderen derselben Anlage (je kWp) = auffällig
  // Anlagengröße: Stockhalle 4 × 30 kWp; BGA laut Christian (07.11.2026), im Solar-Log sind weniger kWp eingetragen
  const ANLAGEN = [
    { key: 'stockhalle', titel: 'Stockhalle', kwp: 120, quelle: 'growatt' },
    { key: 'neu', titel: 'BGA neu', kwp: 570, quelle: 'solarlog' },
    { key: 'alt', titel: 'BGA alt', kwp: 108, quelle: 'solarlog' }
  ];

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
    return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function zahlOderNull(x) { return x === null || x === undefined ? null : Number(x); }
  const tagBerlin = (d) => window.PvTag.tagBerlin(d);
  function tagText(iso) {
    const [j, m, t] = iso.split('-');
    return t + '.' + m + '.' + j;
  }
  function tageVon(ab, bis) { return Math.round((Date.parse(bis) - Date.parse(ab)) / 86400000) + 1; }
  function zahlenZeile(klasse, paare) {
    const z = el('div', klasse);
    paare.forEach(([wert, text]) => {
      const d = el('div');
      d.append(el('div', 'zahl', wert), el('div', 'text', text));
      z.append(d);
    });
    return z;
  }

  // Tageswerte von Jahresbeginn bis zum gezeigten Tag; Supabase liefert höchstens 1000 Zeilen je Anfrage, deshalb seitenweise
  async function tageswerteHolen(tabelle, spalte, abTag, bisTag) {
    const zeilen = [];
    for (let von = 0; ; von += 1000) {
      const r = await window.sb.from(tabelle).select(spalte + ', tag, kwh').gte('tag', abTag).lte('tag', bisTag)
        .order('tag').order(spalte).range(von, von + 999);
      if (r.error) throw r.error;
      zeilen.push(...(r.data || []));
      if (!r.data || r.data.length < 1000) return zeilen;
    }
  }

  // Ansicht öffnen: Daten holen, jede Minute neu holen (nur für heute); beim Verlassen hört alles auf.
  function zeigePvAnlagen(ziel) {
    const box = el('div', 'ph');
    const leiste = window.PvTag.leiste(() => { inhalt.replaceChildren(el('div', 'ph-stand', 'Lädt …')); holen(); });
    const stand = el('div', 'ph-stand', 'Werte werden geladen …');
    const meldung = el('div', 'ph-meldungen');
    const inhalt = el('div', 'ph');
    box.append(leiste.element, stand, meldung, inhalt);
    ziel.replaceChildren(box);
    let anfrage = 0; // beim schnellen Blättern zählt nur die letzte Antwort
    const offen = {}; // welche Wechselrichter-Listen der Nutzer aufgeklappt hat (bleibt beim Neuzeichnen)

    async function holen() {
      if (!box.isConnected) return;
      const nr = ++anfrage;
      const tag = leiste.tag();
      const ab = tag.slice(0, 4) + '-01-01';
      try {
        const [sw, sl, sa, st, bw, bl, ba, bt] = await Promise.all([
          window.sb.from('pv_wechselrichter').select('*').eq('anlage', 'Stockhalle').order('sortierung'),
          window.sb.from('pv_live').select('sn, gemeldet_am, leistung_w, heute_kwh'),
          window.sb.from('pv_abruf').select('*').maybeSingle(),
          tageswerteHolen('pv_tag', 'sn', ab, tag),
          window.sb.from('pvbga_wechselrichter').select('*').order('sortierung'),
          window.sb.from('pvbga_live').select('*'),
          window.sb.from('pvbga_abruf').select('*').maybeSingle(),
          tageswerteHolen('pvbga_tag', 'id', ab, tag)
        ]);
        if (nr !== anfrage || !box.isConnected) return;
        const fehler = sw.error || sl.error || sa.error || bw.error || bl.error || ba.error;
        if (fehler) throw fehler;

        // Beide Quellen in eine Form bringen: Wechselrichter { id, name, anlage, kwp, zeit, leistung, tagKwh }
        const liveNach = {};
        (sl.data || []).forEach((x) => { liveNach['g:' + x.sn] = { zeit: x.gemeldet_am, w: x.leistung_w, kwh: x.heute_kwh }; });
        (bl.data || []).forEach((x) => { liveNach['s:' + x.id] = { zeit: x.messung_am, w: x.leistung_w, kwh: x.heute_kwh }; });
        const wr = [];
        (sw.data || []).slice().sort((x, y) => (y.nr || 0) - (x.nr || 0)).forEach((w) => {
          // Reihenfolge wie an der Wand von links: Anlage 4, 3, 2, 1
          wr.push({ id: 'g:' + w.sn, name: 'Anlage ' + w.nr, zusatz: w.name, anlage: 'stockhalle', kwp: zahlOderNull(w.kw) });
        });
        (bw.data || []).forEach((w) => {
          wr.push({ id: 's:' + w.id, name: w.name, zusatz: '', anlage: w.anlage, kwp: zahlOderNull(w.kwp) });
        });
        const tage = st.map((t) => ({ id: 'g:' + t.sn, tag: t.tag, kwh: Number(t.kwh) }))
          .concat(bt.map((t) => ({ id: 's:' + t.id, tag: t.tag, kwh: Number(t.kwh) })));
        const quellen = {
          growatt: { name: 'Growatt', erfolg: sa.data && sa.data.letzter_erfolg, fehler: sa.data && sa.data.fehler },
          solarlog: { name: 'Solar-Log', erfolg: ba.data && ba.data.letzter_erfolg, fehler: ba.data && ba.data.fehler }
        };
        zeichnen(inhalt, meldung, stand, wr, liveNach, tage, quellen, tag, offen);
      } catch (e) {
        if (nr !== anfrage || !box.isConnected) return;
        const text = (e && e.message) ? e.message + (e.code ? ' (' + e.code + ')' : '') : String(e);
        meldung.replaceChildren(el('div', 'ph-hinweis fehler', 'Werte konnten nicht geladen werden: ' + text));
        stand.textContent = '';
      }
    }

    const abfrage = setInterval(() => {
      if (!box.isConnected) aufhoeren(); else if (!document.hidden && leiste.istHeute()) holen();
    }, ABFRAGE_MS);
    function sichtbar() { if (!document.hidden && leiste.istHeute()) holen(); }
    document.addEventListener('visibilitychange', sichtbar);
    function aufhoeren() {
      clearInterval(abfrage);
      document.removeEventListener('visibilitychange', sichtbar);
    }
    holen();
  }

  function zeichnen(inhalt, meldung, stand, wechselrichter, liveNach, tage, quellen, tag, offen) {
    const jetzt = Date.now();
    const istHeute = tag === tagBerlin(new Date());
    const monatAb = tag.slice(0, 8) + '01';
    const jahrAb = tag.slice(0, 5) + '01-01';

    const vorher = tage.filter((t) => t.tag < tag && istZahl(t.kwh));
    const summeVorher = (ids, ab) => vorher.filter((t) => ids.has(t.id) && t.tag >= ab).reduce((s, t) => s + t.kwh, 0);
    const amTag = {};
    tage.filter((t) => t.tag === tag).forEach((t) => { amTag[t.id] = t.kwh; });

    const geraete = wechselrichter.map((w) => {
      if (!istHeute) {
        return { w, zeit: null, aktuell: false, leistung: null, tagKwh: istZahl(amTag[w.id]) ? amTag[w.id] : null };
      }
      const x = liveNach[w.id] || {};
      const zeit = x.zeit ? new Date(x.zeit) : null;
      const alterMin = zeit ? (jetzt - zeit.getTime()) / 60000 : Infinity;
      const vonHeute = zeit && tagBerlin(zeit) === tag;
      return {
        w, zeit,
        aktuell: alterMin <= STUMM_MIN,
        leistung: alterMin <= STUMM_MIN ? zahlOderNull(x.w) : null,
        tagKwh: vonHeute ? zahlOderNull(x.kwh) : null
      };
    });

    // Warnungen nur heute und tagsüber: Vergleich innerhalb derselben Anlage, je kWp
    const warnungen = [];
    ANLAGEN.forEach((an) => {
      const gruppe = geraete.filter((g) => g.w.anlage === an.key);
      const aktuelle = gruppe.filter((g) => g.aktuell && istZahl(g.leistung) && g.w.kwp);
      const jeKwp = (g) => g.leistung / g.w.kwp;
      const sonne = istHeute && aktuelle.length && aktuelle.reduce((s, g) => s + jeKwp(g), 0) / aktuelle.length >= SONNE_W_PRO_KWP;
      gruppe.forEach((g) => {
        g.warnung = '';
        if (!sonne) return;
        if (!g.zeit) {
          g.warnung = 'hat heute noch nicht gemeldet';
        } else if (!g.aktuell) {
          g.warnung = 'meldet seit ' + datumZeit(g.zeit) + ' nicht';
        } else if (aktuelle.includes(g)) {
          const andere = aktuelle.filter((b) => b !== g).map(jeKwp);
          if (andere.length) {
            const mittel = andere.reduce((s, v) => s + v, 0) / andere.length;
            if (mittel >= SONNE_W_PRO_KWP && jeKwp(g) < mittel * SCHWACH_ANTEIL) {
              g.warnung = 'liefert nur ' + Math.round(jeKwp(g) / mittel * 100) + ' % der anderen';
            }
          }
        }
        if (g.warnung) warnungen.push(an.titel + ', ' + g.w.name + ' ' + g.warnung + '.');
      });
    });

    // Kopf: wann die beiden Quellen zuletzt geliefert haben (nur heute)
    meldung.replaceChildren();
    stand.classList.remove('alt');
    if (!istHeute) {
      stand.textContent = 'Tageswerte der Wechselrichter (Growatt und Solar-Log)';
    } else {
      const teile = [];
      Object.values(quellen).forEach((q) => {
        if (!q.erfolg) { teile.push(q.name + ': noch nichts'); return; }
        const sek = (jetzt - new Date(q.erfolg).getTime()) / 1000;
        teile.push(q.name + ' ' + vorWieLange(sek));
        if (sek > QUELLE_ALT_MIN * 60) {
          stand.classList.add('alt');
          meldung.append(el('div', 'ph-hinweis', q.name === 'Solar-Log'
            ? 'Achtung: Seit über ' + QUELLE_ALT_MIN + ' Minuten keine Meldung vom Solar-Log (BGA). Läuft der Büro-PC mit dem Solar-Log-Tab?'
            : 'Achtung: Der letzte Abruf bei Growatt (Stockhalle) ist älter als ' + QUELLE_ALT_MIN + ' Minuten.'));
        }
        if (q.fehler) meldung.append(el('div', 'ph-hinweis fehler', q.name + ': letzter Abruf fehlgeschlagen: ' + q.fehler));
      });
      stand.textContent = 'Stand: ' + teile.join(' · ');
    }
    warnungen.forEach((t) => meldung.append(el('div', 'ph-hinweis', t)));

    const box = el('div', 'ph');

    // Summe aller Anlagen
    const mitLeistung = geraete.filter((g) => istZahl(g.leistung));
    const mitTag = geraete.filter((g) => istZahl(g.tagKwh));
    const summeTag = mitTag.reduce((s, g) => s + g.tagKwh, 0);
    const alleIds = new Set(geraete.map((g) => g.w.id));
    const gesamt = el('div', 'ph-gesamt');
    gesamt.append(...zahlenZeile('pa-zwei', istHeute ? [
      [mitLeistung.length ? kw(mitLeistung.reduce((s, g) => s + g.leistung, 0)) : '–', 'alle Anlagen jetzt'],
      [mitTag.length ? kwh(summeTag, 0) : '–', 'alle Anlagen heute']
    ] : [
      [mitTag.length ? kwh(summeTag, 0) : '–', 'alle Anlagen an diesem Tag'],
      [mitTag.length || vorher.length ? kwh(summeVorher(alleIds, monatAb) + summeTag, 0) : '–', 'im Monat bis dahin']
    ]).children);
    box.append(gesamt);

    // Je Anlage eine Karte
    ANLAGEN.forEach((an) => {
      const gruppe = geraete.filter((g) => g.w.anlage === an.key);
      if (!gruppe.length) return;
      const ids = new Set(gruppe.map((g) => g.w.id));
      const leistung = gruppe.filter((g) => istZahl(g.leistung));
      const tagListe = gruppe.filter((g) => istZahl(g.tagKwh));
      const tagSumme = tagListe.reduce((s, g) => s + g.tagKwh, 0);
      const monat = summeVorher(ids, monatAb) + tagSumme;
      const jahr = summeVorher(ids, jahrAb) + tagSumme;
      const eigeneVorher = vorher.filter((t) => ids.has(t.id));
      const daten = leistung.length > 0 || tagListe.length > 0 || eigeneVorher.length > 0;

      const karte = el('div', 'pa-anlage ' + an.key);
      const oben = el('div', 'oben');
      const titel = el('div', 'titel');
      titel.append(el('span', 'name', an.titel), el('span', 'klein', zahl(an.kwp, 0) + ' kWp · ' + gruppe.length + ' Wechselrichter'));
      oben.append(titel);
      oben.append(zahlenZeile('werte', istHeute ? [
        [leistung.length ? kw(leistung.reduce((s, g) => s + g.leistung, 0)) : '–', 'jetzt'],
        [tagListe.length ? kwh(tagSumme, 1) : '–', 'heute'],
        [daten ? kwh(monat, 0) : '–', 'Monat']
      ] : [
        [tagListe.length ? kwh(tagSumme, 1) : '–', 'Tag'],
        [daten ? kwh(monat, 0) : '–', 'Monat'],
        [daten ? kwh(jahr, 0) : '–', 'Jahr']
      ]));
      const spez = el('div', 'spez');
      spez.append(el('div', 'unter', 'kWh pro kWp' + (istHeute ? '' : ' (Monat und Jahr bis zu diesem Tag)')));
      spez.append(zahlenZeile('werte', [
        [tagListe.length ? zahl(tagSumme / an.kwp, 2) : '–', istHeute ? 'heute' : 'Tag'],
        [daten ? zahl(monat / an.kwp, 2) : '–', 'Monat'],
        [daten ? zahl(jahr / an.kwp, 2) : '–', 'Jahr']
      ]));
      oben.append(spez);

      // Unvollständige Zeiträume deutlich dazuschreiben, mit Anzahl der Tage (Christian, 07.11.2026:
      // „solche Fehler dürfen sich nicht einschleichen“): Daten erst seit …, Anlage liefert erst seit …
      const datenAb = eigeneVorher.length ? eigeneVorher[0].tag : (tagListe.length ? tag : null);
      const ertrag = eigeneVorher.filter((t) => t.kwh > 0).map((t) => t.tag);
      if (tagSumme > 0) ertrag.push(tag);
      const betriebAb = ertrag.length ? ertrag.reduce((a, b) => (a < b ? a : b)) : null;
      const tageText = (ab) => {
        const n = tageVon(ab, tag);
        return (ab > monatAb ? 'Monat und Jahr enthalten' : 'Jahr enthält') + ' nur ' + n + (n === 1 ? ' Tag' : ' Tage');
      };
      if (!daten) {
        oben.append(el('div', 'hinweis', 'Für diesen Zeitraum sind keine Werte gespeichert.'));
      } else if (betriebAb && datenAb && betriebAb > datenAb && betriebAb > jahrAb) {
        oben.append(el('div', 'hinweis', an.titel + ' liefert erst seit ' + tagText(betriebAb) + ': ' + tageText(betriebAb)
          + ' (erster Tag nur teilweise).'));
      } else if (datenAb && datenAb > jahrAb) {
        oben.append(el('div', 'hinweis', 'Tageswerte erst seit ' + tagText(datenAb) + ': ' + tageText(datenAb) + '.'));
      }
      karte.append(oben);

      // Wechselrichter zum Aufklappen
      const details = el('details');
      const mitWarnung = gruppe.filter((g) => g.warnung).length;
      details.open = !!offen[an.key] || mitWarnung > 0;
      details.addEventListener('toggle', () => { offen[an.key] = details.open; });
      details.append(el('summary', '', 'Wechselrichter (' + gruppe.length + ')'
        + (mitWarnung ? ' – ' + mitWarnung + ' mit Warnung' : '')));
      const liste = el('div', 'ph-liste');
      gruppe.forEach((g) => {
        const eigen = new Set([g.w.id]);
        const tagG = istZahl(g.tagKwh) ? g.tagKwh : 0;
        const k = el('div', 'ph-anlage' + (g.warnung ? ' warnung' : ''));
        const kz = el('div', 'kopf');
        kz.append(el('span', 'punkt ' + (g.warnung ? 'rot' : g.aktuell ? 'gruen' : 'grau')), el('span', 'nr', g.w.name));
        if (g.w.zusatz) kz.append(el('span', 'name', g.w.zusatz));
        k.append(kz);
        k.append(zahlenZeile('werte', istHeute ? [
          [kw(g.leistung), 'jetzt'],
          [kwh(g.tagKwh, 1), 'heute'],
          [kwh(summeVorher(eigen, monatAb) + tagG, 0), 'Monat']
        ] : [
          [kwh(g.tagKwh, 1), 'Tag'],
          [kwh(summeVorher(eigen, monatAb) + tagG, 0), 'Monat'],
          [kwh(summeVorher(eigen, jahrAb) + tagG, 0), 'Jahr']
        ]));
        // Balken: Anteil an der Nennleistung (Stockhalle 30 kW) bzw. Modulleistung laut Solar-Log
        if (istZahl(g.leistung) && g.w.kwp) {
          const balken = el('div', 'ph-balken');
          const fuell = el('div');
          fuell.style.width = Math.max(0, Math.min(100, g.leistung / (g.w.kwp * 1000) * 100)) + '%';
          balken.append(fuell);
          k.append(balken);
        }
        if (istHeute) {
          const fuss = g.warnung ? g.warnung.charAt(0).toUpperCase() + g.warnung.slice(1)
            : g.zeit ? 'Messwert ' + vorWieLange((jetzt - g.zeit.getTime()) / 1000) : 'heute noch kein Wert';
          k.append(el('div', 'fuss', fuss));
        } else if (!istZahl(g.tagKwh)) {
          k.append(el('div', 'fuss', 'Für diesen Tag kein Wert'));
        }
        liste.append(k);
      });
      details.append(liste);
      karte.append(details);
      box.append(karte);
    });

    box.append(el('div', 'ph-fussnote',
      'Werte der Wechselrichter: Stockhalle von Growatt (etwa 1 % über den Zählern), BGA vom Solar-Log, gemeldet vom Büro-PC '
      + '(nur solange dort der Solar-Log-Tab offen ist; BGA alt stimmt auf etwa 1 % mit ihrem Zähler, BGA neu hat keinen eigenen Zähler). '
      + 'Maßgeblich für die Abrechnung sind die Zähler.'));

    inhalt.replaceChildren(box);
  }

  window.zeigePvAnlagen = zeigePvAnlagen;
})();
