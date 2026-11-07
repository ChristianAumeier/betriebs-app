// Bereich „PV Biogasanlage“: neue PV (570 kWp, seit 28.10.2026) und alte PV (108 kWp) an der Biogasanlage,
// alle 11 Wechselrichter hängen am Solar-Log Base 2000. Ein Skript im Solar-Log-Tab am Büro-PC
// (werkzeuge/solarlog-melder.js) meldet alle 5 Minuten (supabase/032_pv_biogas_solarlog.sql);
// die App liest pvbga_wechselrichter, pvbga_live, pvbga_tag und pvbga_abruf, solange die Ansicht offen ist.

(function () {
  const ABFRAGE_MS = 60000;
  const STUMM_MIN = 60;              // so lange darf ein Wechselrichter tagsüber schweigen
  const MELDUNG_ALT_MIN = 15;        // so alt darf die letzte Meldung vom Solar-Log-Tab sein
  const SONNE_W_PRO_KWP = 20;        // ab 20 W je kWp im Schnitt gilt „Sonne scheint“
  const SCHWACH_ANTEIL = 0.6;        // weniger als 60 % der anderen (je kWp) = auffällig
  // Anlagengröße laut Christian (07.11.2026); im Solar-Log sind weniger kWp eingetragen
  const ANLAGEN = [
    { key: 'neu', titel: 'Neue Anlage', kwp: 570 },
    { key: 'alt', titel: 'Alte Anlage', kwp: 108 }
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
  function tagBerlin(d) { return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }); }
  function tagText(iso) {
    const [j, m, t] = iso.split('-');
    return t + '.' + m + '.' + j;
  }
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
  async function tageswerteHolen(abTag, bisTag) {
    const zeilen = [];
    for (let von = 0; ; von += 1000) {
      const r = await window.sb.from('pvbga_tag').select('id, tag, kwh').gte('tag', abTag).lte('tag', bisTag)
        .order('tag').order('id').range(von, von + 999);
      if (r.error) throw r.error;
      zeilen.push(...(r.data || []));
      if (!r.data || r.data.length < 1000) return zeilen;
    }
  }

  // Ansicht öffnen: Daten holen, jede Minute neu holen (nur für heute); beim Verlassen hört alles auf.
  // Oben die Datumsleiste (pv-tag.js): vergangene Tage zeigen nur Tageswerte.
  function zeigePvBiogas(ziel) {
    const box = el('div', 'ph');
    const leiste = window.PvTag.leiste(() => { inhalt.replaceChildren(el('div', 'ph-stand', 'Lädt …')); holen(); });
    const stand = el('div', 'ph-stand', 'Werte werden geladen …');
    const meldung = el('div', 'ph-meldungen');
    const inhalt = el('div', 'ph');
    box.append(leiste.element, stand, meldung, inhalt);
    ziel.replaceChildren(box);
    let anfrage = 0; // beim schnellen Blättern zählt nur die letzte Antwort

    async function holen() {
      if (!box.isConnected) return;
      const nr = ++anfrage;
      const tag = leiste.tag();
      try {
        const [w, l, a, tage] = await Promise.all([
          window.sb.from('pvbga_wechselrichter').select('*').order('sortierung'),
          window.sb.from('pvbga_live').select('*'),
          window.sb.from('pvbga_abruf').select('*').maybeSingle(),
          tageswerteHolen(tag.slice(0, 4) + '-01-01', tag)
        ]);
        if (nr !== anfrage || !box.isConnected) return;
        const fehler = w.error || l.error || a.error;
        if (fehler) throw fehler;
        zeichnen(inhalt, meldung, stand, w.data || [], l.data || [], a.data, tage, tag);
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
    function sichtbar() { if (!document.hidden) holen(); }
    document.addEventListener('visibilitychange', sichtbar);
    function aufhoeren() {
      clearInterval(abfrage);
      document.removeEventListener('visibilitychange', sichtbar);
    }
    holen();
  }

  // tag = gezeigter Tag (JJJJ-MM-TT). Heute: Live-Werte und Warnungen; früher: nur Tageswerte aus pvbga_tag.
  function zeichnen(inhalt, meldung, stand, wechselrichter, live, abruf, tage, tag) {
    const jetzt = Date.now();
    const istHeute = tag === tagBerlin(new Date());
    const monatAb = tag.slice(0, 8) + '01';
    const jahrAb = tag.slice(0, 5) + '01-01';
    const nachId = {};
    live.forEach((x) => { nachId[x.id] = x; });

    // Tage vor dem gezeigten Tag je Wechselrichter; der gezeigte Tag selbst kommt heute aus den Live-Werten
    const vorher = (tage || []).filter((t) => t.tag < tag && istZahl(Number(t.kwh)));
    const summeVorher = (ids, ab) => vorher.filter((t) => ids.has(t.id) && t.tag >= ab).reduce((s, t) => s + Number(t.kwh), 0);
    const ersterTag = vorher.length ? vorher[0].tag : tag;
    const amTag = {};
    (tage || []).filter((t) => t.tag === tag).forEach((t) => { amTag[t.id] = Number(t.kwh); });

    const geraete = wechselrichter.map((w) => {
      if (!istHeute) {
        return { w, zeit: null, alterMin: Infinity, kwp: zahlOderNull(w.kwp), aktuell: false, leistung: null,
          heuteKwh: istZahl(amTag[w.id]) ? amTag[w.id] : null };
      }
      const x = nachId[w.id] || {};
      const zeit = x.messung_am ? new Date(x.messung_am) : null;
      const alterMin = zeit ? (jetzt - zeit.getTime()) / 60000 : Infinity;
      const vonHeute = zeit && tagBerlin(zeit) === tag;
      return {
        w, zeit, alterMin,
        kwp: zahlOderNull(w.kwp),
        aktuell: alterMin <= STUMM_MIN,
        leistung: alterMin <= STUMM_MIN ? zahlOderNull(x.leistung_w) : null,
        heuteKwh: vonHeute ? zahlOderNull(x.heute_kwh) : null
      };
    });
    const tagWort = istHeute ? 'heute' : 'Tag';

    // Warnungen nur tagsüber: Vergleich innerhalb derselben Anlage, je kWp (laut Solar-Log)
    const warnungen = [];
    ANLAGEN.forEach((an) => {
      const gruppe = geraete.filter((g) => g.w.anlage === an.key);
      const aktuelle = gruppe.filter((g) => g.aktuell && istZahl(g.leistung) && g.kwp);
      const jeKwp = (g) => g.leistung / g.kwp;
      const sonne = aktuelle.length && aktuelle.reduce((s, g) => s + jeKwp(g), 0) / aktuelle.length >= SONNE_W_PRO_KWP;
      gruppe.forEach((g) => {
        g.warnung = '';
        if (!g.zeit) {
          g.warnung = 'hat heute noch nicht gemeldet';
          if (!sonne) g.warnung = '';
        } else if (!g.aktuell && sonne) {
          g.warnung = 'meldet seit ' + datumZeit(g.zeit) + ' nicht';
        } else if (sonne && aktuelle.includes(g)) {
          const andere = aktuelle.filter((b) => b !== g).map(jeKwp);
          if (andere.length) {
            const mittel = andere.reduce((s, v) => s + v, 0) / andere.length;
            if (mittel >= SONNE_W_PRO_KWP && jeKwp(g) < mittel * SCHWACH_ANTEIL) {
              g.warnung = 'liefert nur ' + Math.round(jeKwp(g) / mittel * 100) + ' % der anderen';
            }
          }
        }
        if (g.warnung) warnungen.push(g.w.name + ' ' + g.warnung + '.');
      });
    });

    // Kopf: wann der Solar-Log-Tab zuletzt gemeldet hat (nur heute)
    meldung.replaceChildren();
    stand.classList.remove('alt');
    if (!istHeute) {
      stand.textContent = 'Tageswerte der Wechselrichter vom Solar-Log';
    } else if (abruf && abruf.letzter_erfolg) {
      const sek = (jetzt - new Date(abruf.letzter_erfolg).getTime()) / 1000;
      stand.textContent = 'Vom Solar-Log gemeldet ' + vorWieLange(sek);
      stand.classList.toggle('alt', sek > MELDUNG_ALT_MIN * 60);
      if (sek > MELDUNG_ALT_MIN * 60) {
        meldung.append(el('div', 'ph-hinweis', 'Achtung: Seit über ' + MELDUNG_ALT_MIN
          + ' Minuten keine Meldung. Läuft der Büro-PC mit dem Solar-Log-Tab?'));
      }
    } else {
      stand.textContent = 'Noch keine Meldung vom Solar-Log.';
    }
    if (istHeute && abruf && abruf.fehler) {
      meldung.append(el('div', 'ph-hinweis fehler', 'Letzte Meldung fehlgeschlagen: ' + abruf.fehler));
    }
    warnungen.forEach((t) => meldung.append(el('div', 'ph-hinweis', t)));

    const box = el('div', 'ph');

    // Gesamt über beide Anlagen
    const mitLeistung = geraete.filter((g) => istZahl(g.leistung));
    const mitHeute = geraete.filter((g) => istZahl(g.heuteKwh));
    const summeTag = mitHeute.reduce((s, g) => s + g.heuteKwh, 0);
    const alleIds = new Set(geraete.map((g) => g.w.id));
    const gesamt = el('div', 'ph-gesamt');
    gesamt.append(...zahlenZeile('pb-zwei', istHeute ? [
      [mitLeistung.length ? kw(mitLeistung.reduce((s, g) => s + g.leistung, 0)) : '–', 'Leistung jetzt'],
      [mitHeute.length ? kwh(summeTag, 1) : '–', 'heute erzeugt']
    ] : [
      [mitHeute.length ? kwh(summeTag, 1) : '–', 'an diesem Tag erzeugt'],
      [mitHeute.length || vorher.length ? kwh(summeVorher(alleIds, monatAb) + summeTag, 0) : '–', 'im Monat bis dahin']
    ]).children);
    box.append(gesamt);

    // Erst die Köpfe beider Anlagen (Summe, kWh pro kWp) oben, darunter die Wechselrichter je Anlage
    // (Christian, 07.11.2026: die grüne Anzeige der alten PV soll auch nach oben)
    const koepfe = [];
    const listen = [];
    ANLAGEN.forEach((an) => {
      const gruppe = geraete.filter((g) => g.w.anlage === an.key);
      if (!gruppe.length) return;
      const ids = new Set(gruppe.map((g) => g.w.id));
      const leistung = gruppe.filter((g) => istZahl(g.leistung));
      const heuteListe = gruppe.filter((g) => istZahl(g.heuteKwh));
      const heute = heuteListe.reduce((s, g) => s + g.heuteKwh, 0);
      const monat = summeVorher(ids, monatAb) + heute;
      const jahr = summeVorher(ids, jahrAb) + heute;
      const daten = leistung.length || heuteListe.length || vorher.some((t) => ids.has(t.id));

      const kopf = el('div', 'pb-anlage ' + an.key);
      kopf.append(el('div', 'titel', an.titel + ' · ' + zahl(an.kwp, 0) + ' kWp · ' + gruppe.length + ' Wechselrichter'));
      kopf.append(zahlenZeile('werte', istHeute ? [
        [leistung.length ? kw(leistung.reduce((s, g) => s + g.leistung, 0)) : '–', 'jetzt'],
        [heuteListe.length ? kwh(heute, 1) : '–', 'heute'],
        [daten ? kwh(monat, 0) : '–', 'Monat']
      ] : [
        [heuteListe.length ? kwh(heute, 1) : '–', 'Tag'],
        [daten ? kwh(monat, 0) : '–', 'Monat'],
        [daten ? kwh(jahr, 0) : '–', 'Jahr']
      ]));
      const spez = el('div', 'spez');
      spez.append(el('div', 'unter', 'kWh pro kWp' + (istHeute ? '' : ' (Monat und Jahr bis zu diesem Tag)')));
      spez.append(zahlenZeile('werte', [
        [heuteListe.length ? zahl(heute / an.kwp, 2) : '–', tagWort],
        [daten ? zahl(monat / an.kwp, 2) : '–', 'Monat'],
        [daten ? zahl(jahr / an.kwp, 2) : '–', 'Jahr']
      ]));
      kopf.append(spez);
      // Läuft die Anlage erst seit kurzem (neue PV ab 28.10.2026), sind Monat/Jahr nur wenige Tage:
      // deutlich dazuschreiben, sonst wirkt z. B. 4,39 kWh/kWp im Oktober wie ein Fehler (Christian, 07.11.2026).
      const ertragsTage = vorher.filter((t) => ids.has(t.id) && Number(t.kwh) > 0).map((t) => t.tag);
      if (heute > 0) ertragsTage.push(tag);
      const ersterBetrieb = ertragsTage.length ? ertragsTage.reduce((a, b) => (a < b ? a : b)) : null;
      const tageSeit = (ab) => Math.round((Date.parse(tag) - Date.parse(ab)) / 86400000) + 1;
      if (ersterBetrieb && ersterBetrieb > ersterTag && ersterBetrieb > jahrAb) {
        const imMonat = ersterBetrieb > monatAb;
        const n = tageSeit(ersterBetrieb);
        kopf.append(el('div', 'hinweis wichtig', an.titel + ' liefert erst seit ' + tagText(ersterBetrieb) + ': '
          + (imMonat ? 'Monat und Jahr enthalten' : 'Jahr enthält') + ' nur ' + n + (n === 1 ? ' Tag' : ' Tage')
          + ' (erster Tag nur teilweise).'));
      } else if (!daten) {
        kopf.append(el('div', 'hinweis', 'Für diesen Zeitraum sind keine Werte gespeichert.'));
      } else if (ersterTag > monatAb || ersterTag > jahrAb) {
        const n = tageSeit(ersterTag);
        kopf.append(el('div', 'hinweis wichtig', 'Tageswerte erst seit ' + tagText(ersterTag) + ': '
          + (ersterTag > monatAb ? 'Monat und Jahr enthalten' : 'Jahr enthält') + ' nur ' + n + (n === 1 ? ' Tag.' : ' Tage.')));
      }
      koepfe.push(kopf);

      listen.push(el('div', 'pb-zwischen ' + an.key, 'Wechselrichter ' + an.titel.toLowerCase().replace('anlage', 'Anlage')));
      const liste = el('div', 'ph-liste');
      gruppe.forEach((g) => {
        const eigen = new Set([g.w.id]);
        const tagG = istZahl(g.heuteKwh) ? g.heuteKwh : 0;
        const monatG = summeVorher(eigen, monatAb) + tagG;
        const k = el('div', 'ph-anlage' + (g.warnung ? ' warnung' : ''));
        const kz = el('div', 'kopf');
        kz.append(el('span', 'punkt ' + (g.warnung ? 'rot' : g.aktuell ? 'gruen' : 'grau')),
          el('span', 'nr', g.w.name));
        k.append(kz);
        k.append(zahlenZeile('werte', istHeute ? [
          [kw(g.leistung), 'jetzt'],
          [kwh(g.heuteKwh, 1), 'heute'],
          [kwh(monatG, 0), 'Monat']
        ] : [
          [kwh(g.heuteKwh, 1), 'Tag'],
          [kwh(monatG, 0), 'Monat'],
          [kwh(summeVorher(eigen, jahrAb) + tagG, 0), 'Jahr']
        ]));
        // Balken: Anteil an der Modulleistung laut Solar-Log
        if (istZahl(g.leistung) && g.kwp) {
          const balken = el('div', 'ph-balken');
          const fuell = el('div');
          fuell.style.width = Math.max(0, Math.min(100, g.leistung / (g.kwp * 1000) * 100)) + '%';
          balken.append(fuell);
          k.append(balken);
        }
        if (istHeute) {
          const fuss = g.warnung ? g.warnung.charAt(0).toUpperCase() + g.warnung.slice(1)
            : g.zeit ? 'Messwert ' + vorWieLange((jetzt - g.zeit.getTime()) / 1000) : 'heute noch kein Wert';
          k.append(el('div', 'fuss', fuss));
        } else if (!istZahl(g.heuteKwh)) {
          k.append(el('div', 'fuss', 'Für diesen Tag kein Wert'));
        }
        liste.append(k);
      });
      listen.push(liste);
    });
    box.append(...koepfe, ...listen);

    box.append(el('div', 'ph-fussnote',
      'Werte der Wechselrichter vom Solar-Log, gemeldet vom Büro-PC (nur solange dort der Solar-Log-Tab offen ist). '
      + 'Die alte Anlage stimmt auf etwa 1 % mit ihrem Zähler überein; die neue Anlage hat keinen eigenen Zähler. '
      + 'Maßgeblich für die Abrechnung sind die Zähler.'));

    inhalt.replaceChildren(box);
  }

  window.zeigePvBiogas = zeigePvBiogas;
})();
