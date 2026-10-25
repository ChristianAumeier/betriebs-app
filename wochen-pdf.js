// Wochen-PDF für die Transportfirma: alle Fuhren einer Kalenderwoche mit ALLEN Papieren je Fuhre,
// vorne eine Übersicht (ohne Euro). Zum Teilen per E-Mail (Handy: Teilen-Menü) oder Herunterladen (PC).
// Zusammengefügt im Gerät mit pdf-lib (lib/pdf-lib-1.17.1.min.js, wird erst bei Bedarf geladen).

(function () {
  const BIB = 'lib/pdf-lib-1.17.1.min.js';
  const A4 = [595.28, 841.89];
  const RAND = 28;
  const REIHENFOLGE = ['lieferschein', 'begleitschein', 'registerbeleg', 'wiegeschein', 'altscan'];
  const ARTEN = { lieferschein: 'Lieferschein', begleitschein: 'Begleitschein', registerbeleg: 'Registerbeleg', wiegeschein: 'Wiegeschein', altscan: 'Wiegeschein + Lieferschein' };

  function el(tag, klasse, text) {
    const e = document.createElement(tag);
    if (klasse) e.className = klasse;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function fehlerText(e) { return (e && e.message) ? e.message + (e.code ? ' (' + e.code + ')' : '') : String(e); }
  function tag(d) { return d.toLocaleDateString('sv-SE'); }
  function datum(t) { return t ? t.split('-').reverse().join('.') : ''; }
  function zahl(x, n) { return x === null || x === undefined ? '' : Number(x).toLocaleString('de-DE', { minimumFractionDigits: n || 0, maximumFractionDigits: n || 0 }); }

  // Kalenderwoche nach ISO 8601 (Montag bis Sonntag)
  function kw(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const wt = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - wt);
    const jahr = t.getUTCFullYear();
    const nr = Math.ceil(((t - Date.UTC(jahr, 0, 1)) / 86400000 + 1) / 7);
    const montag = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (wt - 1));
    return { jahr, nr, montag };
  }
  function wochen(anzahl) {
    const l = [];
    const heute = new Date();
    for (let i = 0; i < anzahl; i++) {
      const w = kw(new Date(heute.getFullYear(), heute.getMonth(), heute.getDate() - 7 * i));
      const sonntag = new Date(w.montag); sonntag.setDate(sonntag.getDate() + 6);
      l.push(Object.assign(w, { sonntag }));
    }
    return l;
  }

  let laden = null;
  function bibliothek() {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    if (!laden) {
      laden = new Promise((ok, fehler) => {
        const s = el('script');
        s.src = BIB;
        s.onload = () => ok(window.PDFLib);
        s.onerror = () => { laden = null; fehler(new Error('Die PDF-Bibliothek konnte nicht geladen werden.')); };
        document.head.append(s);
      });
    }
    return laden;
  }

  // Nur Zeichen, die die Standardschrift kann (WinAnsi); Umlaute, ß, €, – gehen
  function sauber(t) {
    return String(t === null || t === undefined ? '' : t).replace(/[^\x20-\x7E\xA0-\xFF€–—„“”‚‘’…]/g, '?');
  }

  // Bild (jpg/png/webp/…) als JPEG-Bytes für die PDF
  async function alsJpeg(blob) {
    if (blob.type === 'image/jpeg') return { art: 'jpg', bytes: new Uint8Array(await blob.arrayBuffer()) };
    if (blob.type === 'image/png') return { art: 'png', bytes: new Uint8Array(await blob.arrayBuffer()) };
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((ok, fehler) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fehler; i.src = url; });
      const c = el('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0);
      const b = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.8));
      return { art: 'jpg', bytes: new Uint8Array(await b.arrayBuffer()) };
    } finally { URL.revokeObjectURL(url); }
  }

  // Übersicht: Tabelle aller Fuhren der Woche
  function uebersicht(doc, L, schrift, fett, woche, fuhren, belegeJe) {
    const spalten = [
      ['Nr.', 20], ['Datum', 54], ['Ladestelle', 108], ['Fahrer', 96], ['Stück', 32], ['Gewicht (t)', 48], ['Begleitschein-Nr.', 82], ['Auftrag', 46], ['Belege', 34]
    ];
    let seite = null, y = 0;
    const neueSeite = (erste) => {
      seite = doc.addPage(A4);
      y = A4[1] - RAND;
      if (erste) {
        seite.drawText(sauber('Lieferscheine KW ' + woche.nr + '/' + woche.jahr + ' – LKW R-AC 5005'), { x: RAND, y: y - 16, size: 16, font: fett });
        seite.drawText(sauber(datum(tag(woche.montag)) + ' bis ' + datum(tag(woche.sonntag)) + ' · ' + fuhren.length + (fuhren.length === 1 ? ' Fuhre' : ' Fuhren') + ' · erstellt ' + new Date().toLocaleString('de-DE')), { x: RAND, y: y - 34, size: 9, font: schrift, color: L.rgb(0.35, 0.35, 0.35) });
        y -= 56;
      }
      let x = RAND;
      seite.drawRectangle({ x: RAND - 2, y: y - 4, width: A4[0] - 2 * RAND + 4, height: 16, color: L.rgb(0.9, 0.93, 0.89) });
      spalten.forEach(([t, b]) => { seite.drawText(sauber(t), { x, y, size: 8, font: fett }); x += b; });
      y -= 18;
    };
    neueSeite(true);
    let stueck = 0, tonnen = 0;
    fuhren.forEach((f, i) => {
      if (y < RAND + 30) neueSeite(false);
      const werte = [String(i + 1), datum(f.datum), f.ladestelle || '', f.fahrer || '', zahl(f.stueck), zahl(f.gewicht_t, 2), f.begleitschein_nr || '', f.auftrag_nr || '', String((belegeJe[f.id] || []).length)];
      let x = RAND;
      werte.forEach((w, k) => {
        let t = sauber(w);
        const breite = spalten[k][1] - 4;
        while (t.length > 1 && schrift.widthOfTextAtSize(t, 8) > breite) t = t.slice(0, -1);
        seite.drawText(t, { x, y, size: 8, font: schrift });
        x += spalten[k][1];
      });
      seite.drawLine({ start: { x: RAND - 2, y: y - 4 }, end: { x: A4[0] - RAND + 2, y: y - 4 }, thickness: 0.3, color: L.rgb(0.8, 0.8, 0.8) });
      y -= 15;
      stueck += f.stueck || 0; tonnen += Number(f.gewicht_t || 0);
    });
    if (y < RAND + 30) neueSeite(false);
    y -= 4;
    seite.drawText(sauber('Zusammen: ' + fuhren.length + (fuhren.length === 1 ? ' Fuhre' : ' Fuhren') + ' · ' + zahl(stueck) + ' Stück · ' + zahl(tonnen, 2) + ' t'), { x: RAND, y, size: 10, font: fett });
    y -= 16;
    seite.drawText(sauber('Danach folgen je Fuhre (in der Reihenfolge der Tabelle) alle Papiere: Lieferschein, Begleitschein, Registerbeleg, Wiegeschein.'), { x: RAND, y, size: 8, font: schrift, color: L.rgb(0.35, 0.35, 0.35) });
  }

  async function erstellen(woche, fortschritt) {
    const L = await bibliothek();
    const von = tag(woche.montag), bis = tag(woche.sonntag);
    const f = await window.sb.from('fuhren_liste').select('*').gte('datum', von).lte('datum', bis).is('storniert_am', null)
      .order('datum').order('id');
    if (f.error) throw f.error;
    const fuhren = f.data || [];
    if (!fuhren.length) throw new Error('In KW ' + woche.nr + ' gibt es keine Fuhren.');
    const b = await window.sb.from('belege').select('*').in('fuhre_id', fuhren.map((x) => x.id)).is('ungueltig_am', null).order('id');
    if (b.error) throw b.error;
    const belegeJe = {};
    (b.data || []).forEach((x) => { (belegeJe[x.fuhre_id] = belegeJe[x.fuhre_id] || []).push(x); });
    Object.values(belegeJe).forEach((l) => l.sort((a, c) => REIHENFOLGE.indexOf(a.art) - REIHENFOLGE.indexOf(c.art) || a.id - c.id));

    const doc = await L.PDFDocument.create();
    doc.setTitle('Lieferscheine KW ' + woche.nr + '/' + woche.jahr);
    doc.setAuthor('Betrieb Aumeier');
    const schrift = await doc.embedFont(L.StandardFonts.Helvetica);
    const fett = await doc.embedFont(L.StandardFonts.HelveticaBold);
    uebersicht(doc, L, schrift, fett, woche, fuhren, belegeJe);

    const gesamt = (b.data || []).length;
    let fertig = 0;
    const fehlt = [];
    for (let i = 0; i < fuhren.length; i++) {
      const fu = fuhren[i];
      for (const beleg of belegeJe[fu.id] || []) {
        const kopf = sauber('Fuhre ' + (i + 1) + ' · ' + datum(fu.datum) + ' · ' + (fu.ladestelle || '') + ' · ' + ARTEN[beleg.art]);
        try {
          const d = await window.sb.storage.from('belege').download(beleg.pfad);
          if (d.error) throw d.error;
          if (beleg.mime === 'application/pdf') {
            const quelle = await L.PDFDocument.load(new Uint8Array(await d.data.arrayBuffer()), { ignoreEncryption: true });
            const seiten = await doc.copyPages(quelle, quelle.getPageIndices());
            seiten.forEach((s) => {
              doc.addPage(s);
              const h = s.getHeight();
              s.drawRectangle({ x: 0, y: h - 12, width: schrift.widthOfTextAtSize(kopf, 7) + 12, height: 12, color: L.rgb(1, 1, 1), opacity: 0.85 });
              s.drawText(kopf, { x: 6, y: h - 9, size: 7, font: schrift, color: L.rgb(0.3, 0.3, 0.3) });
            });
          } else {
            const j = await alsJpeg(d.data);
            const bild = j.art === 'png' ? await doc.embedPng(j.bytes) : await doc.embedJpg(j.bytes);
            const seite = doc.addPage(A4);
            const maxB = A4[0] - 2 * RAND, maxH = A4[1] - 2 * RAND - 14;
            const m = Math.min(maxB / bild.width, maxH / bild.height);
            const bw = bild.width * m, bh = bild.height * m;
            seite.drawText(kopf, { x: RAND, y: A4[1] - RAND, size: 8, font: schrift, color: L.rgb(0.3, 0.3, 0.3) });
            seite.drawImage(bild, { x: (A4[0] - bw) / 2, y: A4[1] - RAND - 14 - bh, width: bw, height: bh });
          }
        } catch (e) {
          fehlt.push(kopf + ': ' + fehlerText(e));
          const seite = doc.addPage(A4);
          seite.drawText(kopf, { x: RAND, y: A4[1] - RAND - 10, size: 10, font: fett });
          seite.drawText(sauber('Dieser Beleg konnte nicht eingefügt werden: ' + fehlerText(e)).slice(0, 110), { x: RAND, y: A4[1] - RAND - 30, size: 9, font: schrift });
        }
        fertig++;
        if (fortschritt) fortschritt(fertig, gesamt);
      }
    }
    const bytes = await doc.save();
    const name = 'Lieferscheine KW ' + woche.nr + ' ' + woche.jahr + ' R-AC 5005.pdf';
    return { datei: new File([bytes], name, { type: 'application/pdf' }), fuhren: fuhren.length, belege: gesamt, fehlt };
  }

  function weitergeben(datei) {
    if (navigator.canShare && navigator.canShare({ files: [datei] }) && /iPhone|iPad|Android/.test(navigator.userAgent)) {
      return navigator.share({ files: [datei], title: datei.name, text: datei.name }).catch((e) => { if (e.name !== 'AbortError') speichern(datei); });
    }
    speichern(datei);
    return Promise.resolve();
  }
  function speichern(datei) {
    const a = el('a');
    a.href = URL.createObjectURL(datei);
    a.download = datei.name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  // Karte für die Fuhren-Ansicht (Chef und Transportfirma)
  function karte() {
    const d = el('details', 'bs-karte bs-formular');
    d.append(el('summary', null, 'Wochen-PDF für die Transportfirma'));
    const f = el('form', 'bs-formular');
    const wahl = el('select');
    wochen(10).forEach((w, i) => {
      const o = el('option', null, 'KW ' + w.nr + ' (' + datum(tag(w.montag)).slice(0, 6) + ' – ' + datum(tag(w.sonntag)) + ')' + (i === 0 ? ' – diese Woche' : ''));
      o.value = i;
      wahl.append(o);
    });
    // Am Wochenanfang ist meist die vergangene Woche gemeint
    if ([1, 2].includes(new Date().getDay())) wahl.value = '1';
    const l = el('label', null, 'Kalenderwoche'); l.append(wahl);
    const knopf = el('button', 'bs-knopf', 'PDF erstellen'); knopf.type = 'submit';
    const meldung = el('div');
    f.append(el('p', 'klein', 'Eine PDF mit allen Fuhren der Woche: vorne eine Übersicht (ohne Euro), danach je Fuhre alle Papiere. Danach „PDF teilen“ tippen: am Handy öffnet sich das Teilen-Menü (z. B. Mail), am PC wird die Datei gespeichert.'), l, knopf, meldung);
    d.append(f);
    const liste = wochen(10);
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      knopf.disabled = true;
      meldung.replaceChildren(el('div', 'bs-hinweis', 'Wird erstellt …'));
      try {
        const r = await erstellen(liste[Number(wahl.value)], (n, g) => { meldung.firstChild.textContent = 'Wird erstellt … ' + n + ' von ' + g + ' Belegen'; });
        const mb = (r.datei.size / 1048576).toLocaleString('de-DE', { maximumFractionDigits: 1 });
        const ok = el('div', 'bs-hinweis ' + (r.fehlt.length ? 'fehler' : 'ok'));
        ok.append(el('div', null, 'Fertig: ' + r.fuhren + ' Fuhren, ' + r.belege + ' Belege, ' + mb + ' MB.' + (r.datei.size > 20 * 1048576 ? ' Achtung: Für viele E-Mail-Postfächer ist das zu groß (meist höchstens 20 MB).' : '')));
        r.fehlt.forEach((t) => ok.append(el('div', null, t)));
        // Teilen braucht ein frisches Tippen (nach dem langen Erstellen erlaubt der Browser es nicht mehr von selbst)
        const nochmal = el('button', 'bs-knopf', 'PDF teilen (z. B. Mail) / speichern'); nochmal.type = 'button';
        nochmal.addEventListener('click', () => weitergeben(r.datei));
        meldung.replaceChildren(ok, nochmal);
      } catch (e) {
        meldung.replaceChildren(el('div', 'bs-hinweis fehler', 'PDF nicht erstellt: ' + fehlerText(e)));
      } finally { knopf.disabled = false; }
    });
    return d;
  }

  window.WochenPdf = { karte, erstellen, kw };
})();
