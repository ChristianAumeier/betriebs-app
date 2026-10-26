// Bereich „Bahnschwellen“: Fuhren unseres LKW mit ihren Belegen (supabase/013_fuhren.sql).
//   Fahrer:          „Neue Fuhre“ → Lieferschein (und Begleitschein, falls da) scannen → „An die Transportfirma senden“; in Nürnberg Wiegeschein.
//   Transportfirma:  Liste „Zu signieren“; signiert selbst in ZEDAL, legt dann Registerbeleg (und Begleitschein, falls er fehlt) zur Fuhre.
//   Chef:            alles, dazu Euro, Ladestellen und Preise, Zugänge, Weitergabe an Claude, Listen.
// Scans und neue Fuhren warten ohne Netz auf dem Handy (IndexedDB) und gehen raus, sobald Netz da ist.
// Ist eine Fuhre komplett, liest Claude sie automatisch aus (Routine über das Repository claude-gedaechtnis).

(function () {
  const ARTEN = {
    lieferschein: 'Lieferschein',
    begleitschein: 'Begleitschein',
    registerbeleg: 'Registerbeleg',
    wiegeschein: 'Wiegeschein',
    altscan: 'Scan (Wiegeschein + Lieferschein)'
  };
  const ABFRAGE_MS = 60000;

  function el(tag, klasse, text) {
    const e = document.createElement(tag);
    if (klasse) e.className = klasse;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function fehlerText(e) {
    return (e && e.message) ? e.message + (e.code ? ' (' + e.code + ')' : '') : String(e);
  }
  function fehlerKasten(text, e) { return el('div', 'bs-hinweis fehler', text + ': ' + fehlerText(e)); }
  function tagVon(d) { return new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }); }
  function datum(tag) { return tag ? tag.split('-').reverse().join('.') : ''; }
  function datumKurz(tag) {
    const [j, m, t] = tag.split('-').map(Number);
    return new Date(j, m - 1, t).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
  }
  function wann(d) {
    return new Date(d).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' Uhr';
  }
  function zahl(x, stellen) {
    return x === null || x === undefined || x === '' ? '–' : Number(x).toLocaleString('de-DE', { minimumFractionDigits: stellen || 0, maximumFractionDigits: stellen || 0 });
  }
  function euro(x) { return x === null || x === undefined ? '–' : Number(x).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }); }
  function zeit(t) { return t ? t.replace(/^0(\d):/, '$1:') : '–'; }
  function sekunden(t) { if (!t) return null; const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); }
  function ausSekunden(s) { s = Math.round(s); return Math.floor(s / 3600) + ':' + String(Math.floor(s / 60) % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
  function monatName(j, m) { return new Date(j, m, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }); }
  function rolle() {
    const p = window.Profil || {};
    return p.rolle === 'chef' ? 'chef' : p.fuhren || null;
  }

  // ---------- Warteschlange im Gerät (IndexedDB) ----------
  // Einträge in Reihenfolge: { typ: 'fuhre', lokal, datum, ladestelle } · { typ: 'beleg', fuhre, art, pfad, blob, mime }
  // · { typ: 'absenden', fuhre }. fuhre ist eine echte Nummer oder eine lokale Kennung „L…“ (Fuhre noch nicht angelegt).
  const Schlange = (function () {
    let dbVersprechen = null;
    function db() {
      if (!dbVersprechen) {
        dbVersprechen = new Promise((ok, fehler) => {
          const r = indexedDB.open('betriebsapp-fuhren', 1);
          r.onupgradeneeded = () => {
            r.result.createObjectStore('schlange', { keyPath: 'nr', autoIncrement: true });
            r.result.createObjectStore('zuordnung', { keyPath: 'lokal' });
          };
          r.onsuccess = () => ok(r.result);
          r.onerror = () => fehler(r.error);
        });
      }
      return dbVersprechen;
    }
    async function tun(store, modus, arbeit) {
      const d = await db();
      return new Promise((ok, fehler) => {
        let t;
        // iPhone: Nach langer Zeit im Hintergrund kann die Verbindung zur Gerätedatenbank weg sein → neu öffnen
        try { t = d.transaction(store, modus); } catch (e) { dbVersprechen = null; fehler(e); return; }
        const s = t.objectStore(store);
        let ergebnis;
        const r = arbeit(s);
        if (r) r.onsuccess = () => { ergebnis = r.result; };
        t.oncomplete = () => ok(ergebnis);
        t.onerror = () => fehler(t.error);
        t.onabort = () => { dbVersprechen = null; fehler(t.error || new Error('Gerätespeicher: Vorgang abgebrochen')); };
      });
    }
    // Nichts darf ewig hängen: nach der Frist gilt der Versuch als gescheitert und wird später wiederholt
    function mitFrist(versprechen, ms, was) {
      let uhr;
      return Promise.race([versprechen, new Promise((_, nein) => { uhr = setTimeout(() => nein(new Error(was + ': keine Antwort nach ' + Math.round(ms / 1000) + ' Sekunden')), ms); })])
        .finally(() => clearTimeout(uhr));
    }
    // Scan aus dem Gerätespeicher holen. Neu: als Bytes (ArrayBuffer) gespeichert, früher als Blob –
    // ein Blob kann am iPhone nach einem Neustart der App unlesbar werden.
    async function scanInhalt(e) {
      if (e.daten) return new Blob([e.daten], { type: e.mime });
      try { return new Blob([await e.blob.arrayBuffer()], { type: e.mime }); } catch (f) {
        throw new Error('Dieser Scan ist auf dem Handy nicht mehr lesbar. Bitte „Verwerfen“ tippen und die Seite neu scannen.');
      }
    }
    const zuhoerer = new Set();
    function melden() { zuhoerer.forEach((f) => { try { f(); } catch (e) {} }); }
    let laeuft = false, laeuftSeit = 0, nochmal = false;

    async function abarbeiten() {
      if (!window.sb) return;
      // Während des Sendens Dazugekommenes gleich danach; hängt ein Durchgang länger als 3 Minuten, neu anfangen
      if (laeuft && Date.now() - laeuftSeit < 180000) { nochmal = true; return; }
      laeuft = true;
      laeuftSeit = Date.now();
      nochmal = false;
      let fehlerDa = false;
      // Scheitert ein Eintrag, warten nur die späteren Einträge DERSELBEN Fuhre (Reihenfolge je Fuhre);
      // alle anderen Fuhren gehen trotzdem raus.
      const gesperrt = new Set();
      try {
        const eintraege = await tun('schlange', 'readonly', (s) => s.getAll());
        for (const e of eintraege) {
          let fuhre = e.fuhre;
          if (gesperrt.has(String(fuhre))) continue;
          if (typeof fuhre === 'string') {
            const z = await tun('zuordnung', 'readonly', (s) => s.get(fuhre));
            if (z) fuhre = z.id; else if (e.typ !== 'fuhre') continue;
          }
          if (gesperrt.has(String(fuhre))) continue;
          try {
            if (e.typ === 'fuhre') {
              const { data, error } = await mitFrist(window.sb.rpc('fuhre_anlegen', { p_datum: e.datum, p_ladestelle: e.ladestelle || null }), 60000, 'Fuhre anlegen');
              if (error) throw error;
              await tun('zuordnung', 'readwrite', (s) => s.put({ lokal: e.lokal, id: data }));
            } else if (e.typ === 'beleg') {
              const inhalt = await scanInhalt(e);
              const pfad = 'fuhren/' + fuhre + '/' + e.art + '-' + e.zufall + '.' + (e.mime === 'application/pdf' ? 'pdf' : e.mime === 'image/png' ? 'png' : 'jpg');
              const hoch = await mitFrist(window.sb.storage.from('belege').upload(pfad, inhalt, { contentType: e.mime, upsert: false }), 180000, 'Scan hochladen');
              if (hoch.error && !/exists|Duplicate/i.test(hoch.error.message || '')) throw hoch.error;
              const { error } = await mitFrist(window.sb.rpc('beleg_eintragen', { p_fuhre: fuhre, p_art: e.art, p_pfad: pfad, p_mime: e.mime, p_groesse: inhalt.size }), 60000, 'Scan eintragen');
              if (error) throw error;
            } else if (e.typ === 'absenden') {
              const { error } = await mitFrist(window.sb.rpc('fuhre_absenden', { p_fuhre: fuhre }), 60000, 'Senden');
              if (error) throw error;
            }
            await tun('schlange', 'readwrite', (s) => s.delete(e.nr));
          } catch (f) {
            fehlerDa = true;
            gesperrt.add(String(e.fuhre)); gesperrt.add(String(fuhre));
            try { await tun('schlange', 'readwrite', (s) => s.put(Object.assign({}, e, { fehler: fehlerText(f), versuch: new Date().toISOString() }))); } catch (g) { /* nächster Durchgang */ }
          }
          melden();
        }
      } catch (f) {
        fehlerDa = true;
      } finally {
        laeuft = false;
        melden();
        if (nochmal && !fehlerDa) setTimeout(abarbeiten, 0);
      }
    }
    async function dazu(eintrag) {
      await tun('schlange', 'readwrite', (s) => s.add(eintrag));
      melden();
      abarbeiten();
    }
    async function alle() { return tun('schlange', 'readonly', (s) => s.getAll()); }
    async function weg(nr) { await tun('schlange', 'readwrite', (s) => s.delete(nr)); melden(); }
    async function echteNummer(lokal) { const z = await tun('zuordnung', 'readonly', (s) => s.get(lokal)); return z ? z.id : null; }
    window.addEventListener('online', () => abarbeiten());
    setInterval(() => { if (navigator.onLine) abarbeiten(); }, 30000);
    return { dazu, alle, weg, abarbeiten, echteNummer, beobachten: (f) => { zuhoerer.add(f); return () => zuhoerer.delete(f); } };
  })();

  function zufall() { return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/-/g, '').slice(0, 16); }

  // Scan aufnehmen (Kamera/Foto) und in die Warteschlange legen
  async function scanDazu(fuhre, art, knopf, datei) {
    let ergebnis;
    try {
      if (datei && datei.type === 'application/pdf') ergebnis = { blob: datei, mime: 'application/pdf' };
      else ergebnis = await window.Scanner.scannen(datei);
    } catch (e) { alert('Scannen hat nicht geklappt: ' + fehlerText(e)); return false; }
    if (!ergebnis) return false;
    if (knopf) knopf.disabled = true;
    // Als Bytes speichern (am iPhone zuverlässiger als ein Blob im Gerätespeicher)
    const daten = await ergebnis.blob.arrayBuffer();
    await Schlange.dazu({ typ: 'beleg', fuhre, art, zufall: zufall(), daten, mime: ergebnis.mime, angelegt: new Date().toISOString() });
    return true;
  }

  // Knopf, der die Kamera öffnet (muss direkt aus dem Tippen heraus die Dateiauswahl starten)
  function scanKnopf(text, fuhre, art, fertig, klasse) {
    const b = el('button', 'bs-knopf ' + (klasse || ''), text);
    b.type = 'button';
    b.addEventListener('click', async () => { if (await scanDazu(fuhre, art, b)) fertig(); });
    return b;
  }
  function dateiKnopf(text, fuhre, art, fertig) {
    const b = el('button', 'bs-knopf leise', text);
    b.type = 'button';
    b.addEventListener('click', async () => {
      const d = await window.Scanner.dateiWaehlen('image/*,application/pdf');
      if (d && await scanDazu(fuhre, art, b, d)) fertig();
    });
    return b;
  }

  // ---------- Daten ----------
  async function preiseLaden() {
    if (rolle() !== 'chef') return [];
    const { data, error } = await window.sb.from('ladestellen_preise').select('*').order('gueltig_ab');
    if (error) throw error;
    return data || [];
  }
  // Gültiger Preis der Ladestelle am Ladetag: { preis, art } mit art 'schwelle' oder 'fuhre' (supabase/014)
  function preisFuer(preise, f) {
    let p = null;
    for (const x of preise) if (x.ladestelle_id === f.ladestelle_id && x.gueltig_ab <= f.datum) p = x;
    return p === null ? null : { preis: Number(p.preis_schwelle), art: p.art || 'schwelle' };
  }
  // Euro für eine Fuhre: pro Fuhre fester Betrag, sonst Stück × Preis (null, wenn Preis oder Stück fehlt)
  function betragFuer(preise, f) {
    const p = preisFuer(preise, f);
    if (!p) return null;
    if (p.art === 'fuhre') return p.preis;
    return f.stueck === null || f.stueck === undefined ? null : p.preis * f.stueck;
  }
  function preisText(p) { return euro(p.preis) + (p.art === 'fuhre' ? ' je Fuhre' : ' je Schwelle'); }
  function ampel(f) {
    if (f.storniert_am) return 'grau';
    if (f.auffaellig || f.weitergabe_fehler) return 'rot';
    if (f.quelle === 'altbestand') return 'gruen';
    const rest = f.abgeschlossen_am || (f.hat_begleitschein && f.hat_registerbeleg);
    if (f.hat_lieferschein && f.hat_wiegeschein && rest && f.ausgelesen_am) return 'gruen';
    return 'gelb';
  }
  // Was fehlt noch? Bei „trotz fehlender Belege abgeschlossen“ (015) nur noch Lieferschein und Wiegeschein
  function fehlt(f) {
    if (f.quelle === 'altbestand') return [];
    const l = [];
    if (f.abgeschlossen_am) {
      if (!f.hat_lieferschein) l.push('Lieferschein');
      if (!f.hat_wiegeschein) l.push('Wiegeschein');
      return l;
    }
    if (!f.hat_lieferschein) l.push('Lieferschein');
    if (!f.hat_begleitschein) l.push('Begleitschein');
    if (!f.abgesendet_am && f.hat_lieferschein) l.push('noch nicht an die Transportfirma gesendet');
    if (!f.hat_registerbeleg) l.push('Registerbeleg');
    if (!f.hat_wiegeschein) l.push('Wiegeschein');
    return l;
  }

  function regelmaessig(box, holen) {
    const abfrage = setInterval(() => { if (!box.isConnected) aufhoeren(); else if (!document.hidden) holen(); }, ABFRAGE_MS);
    function sichtbar() { if (!box.isConnected) aufhoeren(); else if (!document.hidden) holen(); }
    document.addEventListener('visibilitychange', sichtbar);
    const ab = Schlange.beobachten(() => { if (!box.isConnected) aufhoeren(); else holen(); });
    function aufhoeren() { clearInterval(abfrage); document.removeEventListener('visibilitychange', sichtbar); ab(); }
    holen();
  }

  // ---------- Zeile in der Liste ----------
  function fuhrenZeile(f, preise) {
    const a = el('a', 'bs-zeile ' + ampel(f));
    a.href = '#bahnschwellen/' + f.id;
    const oben = el('div', 'oben');
    oben.append(el('span', 'punkt'), el('span', 'datum', datumKurz(f.datum)), el('span', 'ort', f.ladestelle || 'Ladestelle noch offen'),
      el('span', 'fahrer', f.fahrer || ''));
    const unten = el('div', 'unten');
    const teile = [];
    if (f.stueck !== null) teile.push(zahl(f.stueck) + ' Stück');
    if (f.gewicht_t !== null) teile.push(zahl(f.gewicht_t, 2) + ' t');
    if (f.abladezeit) teile.push('Abladen ' + zeit(f.abladezeit));
    if (preise) { const b = betragFuer(preise, f); if (b !== null) teile.push(euro(b)); }
    unten.append(el('span', null, teile.join(' · ') || (f.ausgelesen_am || f.quelle === 'altbestand' ? '' : 'noch nicht ausgelesen')));
    const marken = el('div', 'marken');
    if (f.storniert_am) marken.append(el('span', 'marke', 'storniert'));
    else {
      if (f.quelle === 'app') {
        [['L', f.hat_lieferschein, 'Lieferschein'], ['B', f.hat_begleitschein, 'Begleitschein'], ['R', f.hat_registerbeleg, 'Registerbeleg'], ['W', f.hat_wiegeschein, 'Wiegeschein']]
          .forEach(([k, da, t]) => { const s = el('span', 'beleg' + (da ? ' da' : ''), k); s.title = t + (da ? ' da' : ' fehlt'); marken.append(s); });
        if (f.abgeschlossen_am) marken.append(el('span', 'marke', 'abgeschlossen'));
        if (f.ausgelesen_am) marken.append(el('span', 'marke ok', 'ausgelesen'));
      }
      if (f.auffaellig) marken.append(el('span', 'marke rot', 'prüfen'));
    }
    a.append(oben, unten, marken);
    return a;
  }

  // Wartende Fuhren/Scans aus dem Gerät
  function warteKarte(eintraege, neuZeichnen) {
    if (!eintraege.length) return null;
    const k = el('div', 'bs-karte bs-warten');
    k.append(el('h3', null, navigator.onLine ? 'Wird gesendet …' : 'Wartet auf Netz'));
    const fehler = eintraege.find((e) => e.fehler);
    eintraege.forEach((e) => {
      const z = el(e.typ === 'fuhre' ? 'a' : 'div', 'bs-wartezeile');
      if (e.typ === 'fuhre') z.href = '#bahnschwellen/' + e.lokal;
      z.append(el('span', null, e.typ === 'fuhre' ? 'Neue Fuhre vom ' + datum(e.datum) + ' ›' : e.typ === 'beleg' ? ARTEN[e.art] + ' (Fuhre ' + (typeof e.fuhre === 'string' ? 'neu' : e.fuhre) + ')' : 'An die Transportfirma senden (Fuhre ' + (typeof e.fuhre === 'string' ? 'neu' : e.fuhre) + ')'));
      if (e.fehler) {
        z.append(el('span', 'bs-fehlertext', e.fehler));
        const weg = el('button', 'bs-knopf mini leise', 'Verwerfen');
        weg.addEventListener('click', async () => { if (confirm('Diesen Eintrag verwerfen? Er wird dann nicht gesendet.')) { await Schlange.weg(e.nr); neuZeichnen(); } });
        z.append(weg);
      }
      k.append(z);
    });
    const nochmal = el('button', 'bs-knopf leise', 'Jetzt senden');
    nochmal.addEventListener('click', () => Schlange.abarbeiten());
    k.append(el('p', 'klein', fehler ? 'Etwas hat nicht geklappt (Text oben). Die App versucht es weiter; bei Netz „Jetzt senden“ tippen.' : 'Die App sendet von selbst, sobald Netz da ist. Die App dafür bitte offen lassen oder später wieder öffnen.'), nochmal);
    return k;
  }

  // ---------- Neue Fuhre ----------
  // Ein Knopf, keine Fragen (Christian, 25.10.2026): Ladetag und Ladestelle liest Claude vom Wiegeschein und
  // Lieferschein ab. Angelegt wird mit heutigem Datum und ohne Ladestelle; danach geht es direkt zum Scannen.
  function neueFuhreKnopf(fertig) {
    const b = el('button', 'bs-knopf gross', '＋ Neue Fuhre');
    b.type = 'button';
    b.addEventListener('click', async () => {
      b.disabled = true; // kein zweites Antippen, sonst gäbe es eine leere Fuhre doppelt
      const lokal = 'L' + Date.now();
      await Schlange.dazu({ typ: 'fuhre', lokal, fuhre: lokal, datum: tagVon(new Date()), ladestelle: null, angelegt: new Date().toISOString() });
      setTimeout(() => { b.disabled = false; }, 1500);
      fertig(lokal);
    });
    return b;
  }

  // ---------- Liste ----------
  function zeigeListe(ziel) {
    const r = rolle();
    const box = el('div', 'bs');
    ziel.replaceChildren(box);
    const jetzt = new Date();
    let jahr = jetzt.getFullYear(), monat = jetzt.getMonth();
    let filterOrt = '', filterFahrer = '', suche = '';
    let laeuft = false;
    let ladestellen = [];
    // Teile, die das minütliche Neuladen überstehen müssen (Eingaben, Aufgeklapptes)
    const oben = el('div', 'bs');
    const mitte = el('div', 'bs');
    const monatsKarte = el('div', 'bs-karte');
    const unten = el('div', 'bs');
    box.append(oben, mitte, monatsKarte, unten);
    let neuKarte = null;
    let chefTeile = null;
    let wochenKarte = null;

    const suchFeld = el('input', 'bs-suche'); suchFeld.type = 'search'; suchFeld.placeholder = 'Suchen: Lieferschein-, Begleitschein- oder Auftragsnummer';
    suchFeld.addEventListener('input', () => { suche = suchFeld.value.trim(); holen(); });
    const ortWahl = el('select'); const fahrerWahl = el('select');
    ortWahl.addEventListener('change', () => { filterOrt = ortWahl.value; holen(); });
    fahrerWahl.addEventListener('change', () => { filterFahrer = fahrerWahl.value; holen(); });

    async function holen() {
      if (laeuft) return;
      laeuft = true;
      try {
        const von = jahr + '-' + String(monat + 1).padStart(2, '0') + '-01';
        const bis = new Date(jahr, monat + 1, 1).toLocaleDateString('sv-SE');
        let q = window.sb.from('fuhren_liste').select('*').order('datum', { ascending: false }).order('id', { ascending: false });
        if (suche) q = q.or(['lieferschein_nr', 'begleitschein_nr', 'auftrag_nr'].map((s) => s + '.ilike.*' + suche.replace(/[,()*]/g, '') + '*').join(','));
        else q = q.gte('datum', von).lt('datum', bis);
        const offenQ = r === 'transportfirma'
          ? window.sb.from('fuhren_liste').select('*').not('abgesendet_am', 'is', null).eq('hat_registerbeleg', false).is('storniert_am', null).order('datum')
          : window.sb.from('fuhren_liste').select('*').eq('quelle', 'app').is('storniert_am', null)
              .or('hat_wiegeschein.eq.false,hat_lieferschein.eq.false,and(abgeschlossen_am.is.null,or(hat_begleitschein.eq.false,abgesendet_am.is.null))').order('datum');
        const [m, o, l, p, w] = await Promise.all([q, offenQ, window.sb.from('ladestellen').select('*').order('name'), preiseLaden(), Schlange.alle()]);
        if (m.error || o.error || l.error) throw m.error || o.error || l.error;
        if (!box.isConnected) return;
        ladestellen = l.data || [];
        zeichnen(m.data || [], o.data || [], p, w);
      } catch (e) {
        mitte.replaceChildren(fehlerKasten('Fuhren konnten nicht geladen werden', e));
      } finally { laeuft = false; }
    }

    function zeichnen(fuhren, offene, preise, wartend) {
      // oben: Neue Fuhre (Fahrer/Chef), Warteschlange
      const obenTeile = [];
      if (r !== 'transportfirma') {
        if (!neuKarte) neuKarte = neueFuhreKnopf((lokal) => { location.hash = 'bahnschwellen/' + lokal; });
        obenTeile.push(neuKarte);
      }
      const wk = warteKarte(wartend, holen);
      if (wk) obenTeile.push(wk);
      oben.replaceChildren(...obenTeile);

      // offene Fuhren
      const mitteTeile = [];
      if (r === 'transportfirma') {
        const k = el('div', 'bs-karte');
        k.append(el('h3', null, 'Zu signieren (' + offene.length + ')'));
        if (!offene.length) k.append(el('p', 'klein', 'Alles erledigt. Neue Fuhren kommen als Mitteilung.'));
        offene.forEach((f) => k.append(fuhrenZeile(f)));
        mitteTeile.push(k);
      } else if (offene.length) {
        const k = el('div', 'bs-karte');
        k.append(el('h3', null, 'Offene Fuhren (' + offene.length + ')'));
        k.append(el('p', 'klein', 'Hier fehlt noch etwas. Antippen zum Weiterscannen.'));
        offene.forEach((f) => {
          const z = fuhrenZeile(f, preise.length ? preise : null);
          z.append(el('div', 'fehlt', 'Fehlt: ' + fehlt(f).join(', ')));
          k.append(z);
        });
        mitteTeile.push(k);
      }
      mitte.replaceChildren(...mitteTeile);

      // Monat
      const kopf = el('div', 'bs-monatkopf');
      const zur = el('button', 'bs-pfeil', '‹'); const vor = el('button', 'bs-pfeil', '›');
      zur.addEventListener('click', () => { monat--; if (monat < 0) { monat = 11; jahr--; } holen(); });
      vor.addEventListener('click', () => { monat++; if (monat > 11) { monat = 0; jahr++; } holen(); });
      kopf.append(zur, el('h3', null, suche ? 'Suche „' + suche + '“' : monatName(jahr, monat)), vor);

      const orte = [...new Map(fuhren.filter((f) => f.ladestelle).map((f) => [String(f.ladestelle_id), f.ladestelle])).entries()];
      const fahrer = [...new Set(fuhren.map((f) => f.fahrer).filter(Boolean))].sort();
      if (filterOrt && !orte.some(([id]) => id === filterOrt)) filterOrt = '';
      if (filterFahrer && !fahrer.includes(filterFahrer)) filterFahrer = '';
      ortWahl.replaceChildren(el('option', null, 'Alle Ladestellen'));
      ortWahl.firstChild.value = '';
      orte.forEach(([id, n]) => { const o = el('option', null, n); o.value = id; ortWahl.append(o); });
      ortWahl.value = filterOrt;
      fahrerWahl.replaceChildren(el('option', null, 'Alle Fahrer'));
      fahrerWahl.firstChild.value = '';
      fahrer.forEach((n) => { const o = el('option', null, n); o.value = n; fahrerWahl.append(o); });
      fahrerWahl.value = filterFahrer;
      const filter = el('div', 'bs-filter'); filter.append(ortWahl, fahrerWahl);

      const gezeigt = fuhren.filter((f) => (!filterOrt || String(f.ladestelle_id) === filterOrt) && (!filterFahrer || f.fahrer === filterFahrer));
      const gueltig = gezeigt.filter((f) => !f.storniert_am);
      const stueck = gueltig.reduce((s, f) => s + (f.stueck || 0), 0);
      const tonnen = gueltig.reduce((s, f) => s + Number(f.gewicht_t || 0), 0);
      const zeiten = gueltig.map((f) => sekunden(f.abladezeit)).filter((x) => x !== null);
      const summe = el('div', 'bs-summen');
      const kachel = (wert, text) => { const k = el('div', 'bs-summe'); k.append(el('div', 'wert', wert), el('div', 'text', text)); return k; };
      summe.append(kachel(String(gueltig.length), gueltig.length === 1 ? 'Fuhre' : 'Fuhren'), kachel(zahl(stueck), 'Stück'), kachel(zahl(tonnen, 2), 'Tonnen'),
        kachel(zeiten.length ? zeit(ausSekunden(zeiten.reduce((a, b) => a + b, 0) / zeiten.length)).slice(0, -3) : '–', 'Ø Abladen'));
      let ohnePreis = 0;
      if (r === 'chef') {
        let betrag = 0;
        gueltig.forEach((f) => { if (!preisFuer(preise, f)) { ohnePreis++; return; } betrag += betragFuer(preise, f) || 0; });
        summe.append(kachel(euro(betrag), 'Betrag'));
      }
      const liste = el('div', 'bs-liste');
      gezeigt.forEach((f) => liste.append(fuhrenZeile(f, r === 'chef' ? preise : null)));
      if (!gezeigt.length) liste.append(el('p', 'klein', suche ? 'Nichts gefunden.' : 'Keine Fuhren in diesem Monat.'));
      const teile = [kopf, suchFeld, filter, summe];
      if (ohnePreis) teile.push(el('div', 'bs-hinweis', ohnePreis + (ohnePreis === 1 ? ' Fuhre hat' : ' Fuhren haben') + ' noch keinen Preis (unten unter „Ladestellen und Preise“ eintragen).'));
      teile.push(liste);
      if (r === 'chef' && gezeigt.length) {
        const knoepfe = el('div', 'bs-knoepfe');
        const csv = el('button', 'bs-knopf leise', 'Liste als CSV (Excel)');
        csv.addEventListener('click', () => csvHerunterladen(gezeigt, preise, 'Fuhren ' + jahr + '-' + String(monat + 1).padStart(2, '0') + '.csv'));
        const xl = el('button', 'bs-knopf leise', 'Monats-Auswertung (Excel)');
        xl.addEventListener('click', () => excelHerunterladen(jahr + '-' + String(monat + 1).padStart(2, '0'), xl));
        knoepfe.append(csv, xl);
        teile.push(knoepfe);
      }
      monatsKarte.replaceChildren(...teile);

      // Wochen-PDF (wochen-pdf.js) für Chef und Transportfirma; einmal gebaut, damit die Auswahl stehen bleibt
      if (!wochenKarte && (r === 'chef' || r === 'transportfirma') && window.WochenPdf) wochenKarte = window.WochenPdf.karte();
      if (r === 'chef') {
        if (!chefTeile) chefTeile = chefKarten(() => holen());
        chefTeile.auffrischen(ladestellen, preise);
        unten.replaceChildren(...[wochenKarte].filter(Boolean), ...chefTeile.karten);
      } else if (!unten.childNodes.length && window.Meldungen) {
        unten.replaceChildren(...[wochenKarte].filter(Boolean),
          window.Meldungen.karte(r === 'transportfirma' ? 'Mitteilungen bei neuen Fuhren' : 'Mitteilungen zu den Fuhren'));
      }
    }

    regelmaessig(box, holen);
  }

  // ---------- Eine Fuhre ----------
  async function zeigeFuhre(ziel, kennung) {
    const r = rolle();
    const box = el('div', 'bs');
    ziel.replaceChildren(box);
    let id = /^\d+$/.test(kennung) ? Number(kennung) : null;
    if (!id) {
      // noch nicht angelegte Fuhre aus dem Gerät
      const echt = await Schlange.echteNummer(kennung);
      if (echt) { location.replace('#bahnschwellen/' + echt); return; }
    }
    let laeuft = false;
    const kopf = el('div', 'bs');
    const belegeBox = el('div', 'bs');
    const chefBox = el('div', 'bs');
    box.append(kopf, belegeBox, chefBox);
    let bearbeiten = null;
    let urls = {};

    async function holen() {
      if (laeuft) return;
      laeuft = true;
      try {
        // Wartende Einträge dieser Fuhre (auch solche, die noch unter der Kennung aus dem Gerät stehen)
        const wartend = [];
        for (const e of await Schlange.alle()) {
          let fu = e.fuhre;
          if (typeof fu === 'string' && fu !== kennung) fu = (await Schlange.echteNummer(fu)) || fu;
          if (fu === (id || kennung)) wartend.push(e);
        }
        if (!id) {
          const echt = await Schlange.echteNummer(kennung);
          if (echt) { location.replace('#bahnschwellen/' + echt); return; }
          zeichnenLokal(wartend);
          return;
        }
        const [f, b, p, l] = await Promise.all([
          window.sb.from('fuhren_liste').select('*').eq('id', id).maybeSingle(),
          window.sb.from('belege').select('*').eq('fuhre_id', id).order('id'),
          preiseLaden(),
          r === 'chef' ? window.sb.from('ladestellen').select('*').order('name') : Promise.resolve({ data: [] })
        ]);
        if (f.error || b.error) throw f.error || b.error;
        if (!f.data) { kopf.replaceChildren(el('div', 'bs-hinweis fehler', 'Diese Fuhre gibt es nicht (mehr).')); return; }
        const fehlendeUrls = (b.data || []).filter((x) => !urls[x.pfad]).map((x) => x.pfad);
        if (fehlendeUrls.length) {
          const s = await window.sb.storage.from('belege').createSignedUrls(fehlendeUrls, 3600);
          (s.data || []).forEach((x) => { if (x.signedUrl) urls[x.path] = x.signedUrl; });
        }
        if (!box.isConnected) return;
        zeichnen(f.data, b.data || [], p, l.data || [], wartend);
      } catch (e) {
        kopf.replaceChildren(fehlerKasten('Fuhre konnte nicht geladen werden', e));
      } finally { laeuft = false; }
    }

    function zeichnenLokal(wartend) {
      const f = wartend.find((e) => e.typ === 'fuhre');
      if (!f) { kopf.replaceChildren(el('div', 'bs-hinweis', 'Diese Fuhre ist schon gesendet. Bitte zurück zur Liste.')); belegeBox.replaceChildren(); return; }
      const k = el('div', 'bs-karte');
      k.append(el('h3', null, 'Neue Fuhre vom ' + datum(f.datum)), el('div', 'bs-hinweis', navigator.onLine ? 'Wird gesendet …' : 'Wartet auf Netz. Du kannst trotzdem schon scannen.'));
      kopf.replaceChildren(k);
      belegeBox.replaceChildren(scanBereich({ id: kennung, quelle: 'app' }, [], wartend));
    }

    function zeichnen(f, belege, preise, ladestellen, wartend) {
      // Kopf mit Werten
      const k = el('div', 'bs-karte bs-kopf ' + ampel(f));
      k.append(el('h3', null, datumKurz(f.datum) + ' · ' + (f.ladestelle || 'Ladestelle noch offen')));
      const werte = el('dl', 'bs-werte');
      const zeile = (t, w) => { werte.append(el('dt', null, t), el('dd', null, w === null || w === undefined || w === '' ? '–' : w)); };
      zeile('Fahrer', f.fahrer);
      zeile('LKW', f.lkw);
      zeile('Stück', f.stueck === null ? null : zahl(f.stueck));
      zeile('Gewicht', f.gewicht_t === null ? null : zahl(f.gewicht_t, 2) + ' t');
      zeile('Abladezeit', f.abladezeit ? zeit(f.abladezeit) : null);
      zeile('Begleitschein-Nr.', f.begleitschein_nr);
      zeile('Auftrags-Nr. (Wiegeschein)', f.auftrag_nr);
      if (f.lieferschein_nr) zeile('Lieferschein-Nr.', f.lieferschein_nr);
      zeile('Vertrag', f.vertrag);
      if (r === 'chef') {
        const p = preisFuer(preise, f);
        const b = betragFuer(preise, f);
        zeile('Betrag', !p ? 'Preis fehlt' : (b === null ? '–' : euro(b)) + ' (' + preisText(p) + ')');
      }
      k.append(werte);
      const stand = [];
      if (f.quelle === 'altbestand') stand.push('Aus der Excel-Auswertung übernommen.');
      if (f.abgesendet_am) stand.push('An die Transportfirma gesendet ' + wann(f.abgesendet_am) + '.');
      if (f.ausgelesen_am) stand.push('Von Claude ausgelesen ' + wann(f.ausgelesen_am) + '.');
      else if (f.weitergegeben_am) stand.push('Liegt bei Claude zum Auslesen (seit ' + wann(f.weitergegeben_am) + ').');
      k.append(el('p', 'klein', stand.join(' ')));
      if (f.hinweise) k.append(el('div', 'bs-hinweis' + (f.auffaellig ? ' fehler' : ''), f.hinweise));
      if (f.weitergabe_fehler) k.append(el('div', 'bs-hinweis fehler', 'Weitergabe an Claude hat nicht geklappt: ' + f.weitergabe_fehler));
      if (f.storniert_am) k.append(el('div', 'bs-hinweis fehler', 'Storniert ' + wann(f.storniert_am) + ': ' + (f.storno_grund || '')));
      if (f.abgeschlossen_am) k.append(el('div', 'bs-hinweis ok', 'Abgeschlossen ohne fehlende Belege (' + wann(f.abgeschlossen_am) + '): ' + (f.abschluss_grund || '')));
      const fl = fehlt(f);
      if (fl.length && !f.storniert_am) k.append(el('div', 'bs-hinweis', 'Fehlt noch: ' + fl.join(', ')));
      // Chef: Fuhre trotz fehlender Belege abschließen (z. B. Begleitschein nicht mehr vorhanden)
      if (r === 'chef' && f.quelle === 'app' && !f.storniert_am && !f.abgeschlossen_am && f.hat_lieferschein && f.hat_wiegeschein &&
          (!f.hat_begleitschein || !f.hat_registerbeleg)) {
        const d = el('details', 'bs-formular');
        d.append(el('summary', null, 'Fehlende Belege gibt es nicht mehr? Fuhre trotzdem abschließen'));
        const fo = el('form', 'bs-formular');
        const grund = el('input'); grund.required = true; grund.value = 'Belege nicht mehr vorhanden (vor Einführung der App)';
        const lg = el('label', null, 'Grund'); lg.append(grund);
        const kn = el('button', 'bs-knopf', 'Abschließen und auslesen lassen'); kn.type = 'submit';
        fo.append(el('p', 'klein', 'Die Fuhre zählt dann als komplett und wird aus Lieferschein und Wiegeschein ausgelesen.'), lg, kn);
        fo.addEventListener('submit', async (ev) => {
          ev.preventDefault(); kn.disabled = true;
          const { error } = await window.sb.rpc('fuhre_abschliessen', { p_fuhre: f.id, p_grund: grund.value });
          kn.disabled = false;
          if (error) { fo.append(fehlerKasten('Nicht abgeschlossen', error)); return; }
          holen();
        });
        d.append(fo);
        k.append(d);
      }
      kopf.replaceChildren(k);

      belegeBox.replaceChildren(scanBereich(f, belege, wartend));

      if (r === 'chef') {
        if (!bearbeiten) bearbeiten = chefFuhre(f, ladestellen, () => holen());
        chefBox.replaceChildren(bearbeiten);
      }
    }

    // Belege je Art mit Vorschaubildern, Scan-Knöpfen, Absenden
    function scanBereich(f, belege, wartend) {
      const teile = el('div', 'bs');
      const gueltig = belege.filter((b) => !b.ungueltig_am);
      const fertig = () => holen();
      const darfScannen = r === 'chef' || r === 'fahrer';
      const arten = f.quelle === 'altbestand' ? ['altscan', 'lieferschein', 'begleitschein', 'registerbeleg', 'wiegeschein'] : ['lieferschein', 'begleitschein', 'registerbeleg', 'wiegeschein'];
      const alleBilder = [];
      arten.forEach((art) => {
        const eigene = gueltig.filter((b) => b.art === art);
        const warten = wartend.filter((e) => e.typ === 'beleg' && e.art === art);
        if (art === 'altscan' && !eigene.length) return;
        if (f.quelle === 'altbestand' && art !== 'altscan' && !eigene.length) return;
        const k = el('div', 'bs-karte bs-belegart');
        const titel = el('div', 'titel');
        titel.append(el('span', 'name', ARTEN[art]), el('span', 'zustand ' + (eigene.length ? 'da' : warten.length ? 'warten' : 'fehlt'),
          eigene.length ? (eigene.length === 1 ? '✓ da' : '✓ ' + eigene.length + ' Seiten') : warten.length ? 'wird gesendet' : 'fehlt'));
        k.append(titel);
        const bilder = el('div', 'bs-bilder');
        eigene.forEach((b) => {
          const i = alleBilder.length;
          alleBilder.push(b);
          const t = el('button', 'bs-bild');
          t.type = 'button';
          if (b.mime === 'application/pdf') t.append(el('span', 'pdf', 'PDF'));
          else { const img = el('img'); img.loading = 'lazy'; img.src = urls[b.pfad] || ''; img.alt = ARTEN[art]; t.append(img); }
          t.addEventListener('click', () => betrachter(alleBilder, i));
          bilder.append(t);
        });
        warten.forEach(() => bilder.append(el('div', 'bs-bild warten', '⏳')));
        if (eigene.length || warten.length) k.append(bilder);
        const knoepfe = el('div', 'bs-knoepfe');
        const fuhreKennung = f.id;
        if (!f.storniert_am && f.quelle === 'app') {
          // Registerbeleg: Transportfirma und Chef; Begleitschein darf die Transportfirma auch dranhängen (018)
          if ((art === 'registerbeleg' && (r === 'transportfirma' || r === 'chef')) || (art === 'begleitschein' && r === 'transportfirma')) {
            knoepfe.append(scanKnopf(eigene.length ? 'Weitere Seite scannen' : ARTEN[art] + ' scannen', fuhreKennung, art, fertig, eigene.length ? 'leise' : ''),
              dateiKnopf('Als Datei hochladen (PDF/Bild)', fuhreKennung, art, fertig));
          } else if (darfScannen && art !== 'registerbeleg') {
            knoepfe.append(scanKnopf(eigene.length || warten.length ? 'Weitere Seite scannen' : ARTEN[art] + ' scannen', fuhreKennung, art, fertig, eigene.length || warten.length ? 'leise' : ''));
          }
        }
        if (knoepfe.childNodes.length) k.append(knoepfe);
        teile.append(k);
      });

      // Absenden an die Transportfirma
      if ((r === 'chef' || r === 'fahrer') && f.quelle === 'app' && !f.storniert_am && !f.abgesendet_am && !f.abgeschlossen_am) {
        const hatL = gueltig.some((b) => b.art === 'lieferschein') || wartend.some((e) => e.art === 'lieferschein');
        const hatB = gueltig.some((b) => b.art === 'begleitschein') || wartend.some((e) => e.art === 'begleitschein');
        const schon = wartend.some((e) => e.typ === 'absenden');
        const k = el('div', 'bs-karte');
        const b = el('button', 'bs-knopf gross senden', schon ? 'Wird gesendet …' : 'An die Transportfirma senden');
        b.disabled = schon || !hatL;
        b.addEventListener('click', async () => {
          b.disabled = true;
          await Schlange.dazu({ typ: 'absenden', fuhre: f.id, angelegt: new Date().toISOString() });
          holen();
        });
        k.append(b, el('p', 'klein', !hatL ? 'Erst den Lieferschein scannen, dann senden.'
          : hatB ? 'Die Transportfirma bekommt sofort eine Mitteilung und kann signieren.'
          : 'Die Transportfirma bekommt sofort eine Mitteilung. Den Begleitschein kann sie selbst dranhängen.'));
        teile.append(k);
      }

      // als falsch markierte Scans
      const falsch = belege.filter((b) => b.ungueltig_am);
      if (falsch.length) teile.append(el('p', 'klein', falsch.length + ' Scan(s) als falsch markiert (bleiben gespeichert).'));
      return teile;
    }

    // Großansicht: wischen, zoomen, als falsch markieren
    function betrachter(liste, start) {
      let i = start;
      const huelle = el('div', 'bs-betrachter');
      const leiste = el('div', 'leiste');
      const titel = el('span', 'titel');
      const zu = el('button', 'zu', '✕');
      leiste.append(titel, zu);
      const flaeche = el('div', 'flaeche');
      const unten = el('div', 'leiste');
      const zurueck = el('button', null, '‹');
      const zoom = el('button', null, 'Zoom');
      const falsch = el('button', 'leise', 'Falscher Scan');
      const weiter = el('button', null, '›');
      unten.append(zurueck, zoom, falsch, weiter);
      huelle.append(leiste, flaeche, unten);
      document.body.append(huelle);
      document.body.classList.add('sc-offen');
      let gross = false;
      function zeigen() {
        const b = liste[i];
        titel.textContent = ARTEN[b.art] + ' · ' + (i + 1) + ' von ' + liste.length;
        flaeche.replaceChildren();
        flaeche.scrollTo(0, 0);
        if (b.mime === 'application/pdf') {
          const a = el('a', 'bs-knopf', 'PDF öffnen'); a.href = urls[b.pfad]; a.target = '_blank'; a.rel = 'noopener';
          flaeche.append(a);
        } else {
          const img = el('img'); img.src = urls[b.pfad]; img.className = gross ? 'gross' : '';
          img.addEventListener('dblclick', () => { gross = !gross; img.className = gross ? 'gross' : ''; });
          flaeche.append(img);
        }
        zurueck.disabled = i === 0; weiter.disabled = i === liste.length - 1;
      }
      function schliessen() { document.body.classList.remove('sc-offen'); huelle.remove(); }
      zu.addEventListener('click', schliessen);
      zurueck.addEventListener('click', () => { if (i > 0) { i--; zeigen(); } });
      weiter.addEventListener('click', () => { if (i < liste.length - 1) { i++; zeigen(); } });
      zoom.addEventListener('click', () => { gross = !gross; zeigen(); });
      falsch.addEventListener('click', async () => {
        const grund = prompt('Warum ist der Scan falsch? (z. B. unscharf, falsches Blatt)');
        if (!grund) return;
        const { error } = await window.sb.rpc('beleg_ungueltig', { p_beleg: liste[i].id, p_grund: grund });
        if (error) { alert('Hat nicht geklappt: ' + fehlerText(error)); return; }
        schliessen(); holen();
      });
      let x0 = null;
      flaeche.addEventListener('touchstart', (e) => { x0 = e.touches.length === 1 && !gross ? e.touches[0].clientX : null; }, { passive: true });
      flaeche.addEventListener('touchend', (e) => {
        if (x0 === null) return;
        const dx = e.changedTouches[0].clientX - x0;
        if (dx < -60 && i < liste.length - 1) { i++; zeigen(); } else if (dx > 60 && i > 0) { i--; zeigen(); }
        x0 = null;
      });
      zeigen();
    }

    regelmaessig(box, holen);
  }

  // ---------- Chef: Fuhre berichtigen / stornieren ----------
  function chefFuhre(f, ladestellen, fertig) {
    const d = el('details', 'bs-karte bs-formular');
    d.append(el('summary', null, 'Werte berichtigen'));
    const form = el('form', 'bs-formular');
    const felder = {};
    const feld = (name, text, typ, wert) => {
      const i = el('input'); i.type = typ; i.value = wert === null || wert === undefined ? '' : wert;
      if (typ === 'number') i.step = 'any';
      const l = el('label', null, text); l.append(i); form.append(l); felder[name] = i;
    };
    feld('datum', 'Ladetag', 'date', f.datum);
    const ort = el('select');
    const leer = el('option', null, '–'); leer.value = ''; ort.append(leer);
    ladestellen.forEach((l) => { const o = el('option', null, l.name + ' (' + l.vertrag + ')'); o.value = l.id; if (l.id === f.ladestelle_id) o.selected = true; ort.append(o); });
    const lo = el('label', null, 'Ladestelle'); lo.append(ort); form.append(lo);
    feld('fahrer', 'Fahrer (zwei Namen: „A / B“)', 'text', f.fahrer);
    feld('stueck', 'Stück', 'number', f.stueck);
    feld('gewicht_t', 'Gewicht (t)', 'number', f.gewicht_t);
    feld('abladezeit', 'Abladezeit (h:mm:ss)', 'text', f.abladezeit);
    feld('begleitschein_nr', 'Begleitschein-Nr.', 'text', f.begleitschein_nr);
    feld('auftrag_nr', 'Auftrags-Nr.', 'text', f.auftrag_nr);
    feld('lieferschein_nr', 'Lieferschein-Nr.', 'text', f.lieferschein_nr);
    feld('hinweise', 'Hinweis', 'text', f.hinweise);
    const ok = el('label', 'bs-haken'); const okBox = el('input'); okBox.type = 'checkbox'; okBox.checked = !f.auffaellig;
    ok.append(okBox, document.createTextNode(' geprüft, alles in Ordnung')); form.append(ok);
    const speichern = el('button', 'bs-knopf', 'Speichern'); speichern.type = 'submit';
    const meldung = el('div');
    form.append(speichern, meldung);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      speichern.disabled = true;
      const w = { ladestelle_id: ort.value ? Number(ort.value) : null, auffaellig: !okBox.checked };
      Object.entries(felder).forEach(([n, i]) => { w[n] = i.value === '' ? null : i.type === 'number' ? Number(i.value) : i.value; });
      if (w.datum === null) delete w.datum;
      const { error } = await window.sb.rpc('fuhre_aendern', { p_fuhre: f.id, p_werte: w });
      speichern.disabled = false;
      meldung.replaceChildren(error ? fehlerKasten('Nicht gespeichert', error) : el('div', 'bs-hinweis ok', 'Gespeichert.'));
      if (!error) fertig();
    });
    if (!f.storniert_am) {
      const st = el('button', 'bs-knopf leise rot', 'Fuhre stornieren'); st.type = 'button';
      st.addEventListener('click', async () => {
        const grund = prompt('Grund für das Stornieren (die Fuhre bleibt gespeichert):');
        if (!grund) return;
        const { error } = await window.sb.rpc('fuhre_stornieren', { p_fuhre: f.id, p_grund: grund });
        if (error) { alert('Hat nicht geklappt: ' + fehlerText(error)); return; }
        fertig();
      });
      form.append(st);
    }
    d.append(form);
    return d;
  }

  // ---------- Chef: Ladestellen, Preise, Zugänge, Weitergabe ----------
  function chefKarten(fertig) {
    // Ladestellen und Preise
    const lp = el('details', 'bs-karte bs-formular');
    lp.append(el('summary', null, 'Ladestellen und Preise'));
    const lpInhalt = el('div', 'bs');
    lp.append(lpInhalt);
    let lpStand = '';

    function ladestellenZeichnen(ladestellen, preise) {
      const stand = JSON.stringify([ladestellen, preise]);
      if (stand === lpStand) return;
      lpStand = stand;
      const teile = [];
      ladestellen.forEach((l) => {
        const eigene = preise.filter((p) => p.ladestelle_id === l.id);
        const z = el('div', 'bs-ladestelle');
        z.append(el('div', 'name', l.name + ' · Vertrag ' + l.vertrag));
        z.append(el('div', 'klein', eigene.length ? eigene.map((p) => 'ab ' + datum(p.gueltig_ab) + ': ' + preisText({ preis: Number(p.preis_schwelle), art: p.art })).join(' · ') : 'Noch kein Preis'));
        const f = el('form', 'bs-zeilenform');
        const ab = el('input'); ab.type = 'date'; ab.required = true; ab.value = tagVon(new Date()).slice(0, 8) + '01';
        const pr = el('input'); pr.type = 'number'; pr.step = '0.01'; pr.min = '0'; pr.required = true; pr.placeholder = '€';
        // Abrechnung hängt an der Ladestelle: pro Schwelle oder fester Betrag pro Fuhre
        const art = el('select');
        [['schwelle', 'je Schwelle'], ['fuhre', 'je Fuhre']].forEach(([w, t]) => { const o = el('option', null, t); o.value = w; art.append(o); });
        art.value = eigene.length ? (eigene[eigene.length - 1].art || 'schwelle') : 'schwelle';
        const b = el('button', 'bs-knopf mini', 'Preis setzen'); b.type = 'submit';
        f.append(ab, pr, art, b);
        f.addEventListener('submit', async (ev) => {
          ev.preventDefault(); b.disabled = true;
          const { error } = await window.sb.rpc('preis_setzen', { p_ladestelle: l.id, p_gueltig_ab: ab.value, p_preis: Number(pr.value), p_art: art.value });
          b.disabled = false;
          if (error) { f.append(fehlerKasten('Nicht gespeichert', error)); return; }
          fertig();
        });
        z.append(f);
        teile.push(z);
      });
      const neu = el('form', 'bs-zeilenform');
      const v = el('input'); v.required = true; v.placeholder = 'Vertragsnummer';
      const n = el('input'); n.required = true; n.placeholder = 'Name, z. B. 3386 Plattling';
      const b = el('button', 'bs-knopf mini', 'Ladestelle anlegen'); b.type = 'submit';
      neu.append(v, n, b);
      neu.addEventListener('submit', async (ev) => {
        ev.preventDefault(); b.disabled = true;
        const { error } = await window.sb.rpc('ladestelle_speichern', { p_vertrag: v.value, p_name: n.value });
        b.disabled = false;
        if (error) { neu.append(fehlerKasten('Nicht gespeichert', error)); return; }
        fertig();
      });
      teile.push(el('p', 'klein', 'Neue Ladestellen legt Claude beim Auslesen selbst an (dann fehlt nur der Preis).'), neu);
      lpInhalt.replaceChildren(...teile);
    }

    // Zugänge
    const zg = el('details', 'bs-karte bs-formular');
    zg.append(el('summary', null, 'Zugänge für Fahrer und Transportfirma'));
    const zgListe = el('div', 'bs');
    zg.append(zgListe, kontoFormular(() => personenLaden()));
    async function personenLaden() {
      const { data, error } = await window.sb.from('personen').select('user_id, name, rolle, stempelt, fuhren').neq('rolle', 'chef').order('name');
      if (error) { zgListe.replaceChildren(fehlerKasten('Personen nicht lesbar', error)); return; }
      const teile = [el('p', 'klein', 'Fahrer sehen alle Fuhren unseres LKW (ohne Euro). Die Transportfirma sieht die Fuhren und legt nur den Registerbeleg ab.')];
      (data || []).forEach((p) => {
        const z = el('div', 'bs-person');
        const s = el('select');
        [['', 'kein Zugang'], ['fahrer', 'Fahrer'], ['transportfirma', 'Transportfirma']].forEach(([w, t]) => { const o = el('option', null, t); o.value = w; s.append(o); });
        s.value = p.fuhren || '';
        s.addEventListener('change', async () => {
          const { error: e } = await window.sb.rpc('person_fuhren_setzen', { p_user: p.user_id, p_fuhren: s.value || null });
          if (e) { alert('Hat nicht geklappt: ' + fehlerText(e)); s.value = p.fuhren || ''; } else p.fuhren = s.value || null;
        });
        z.append(el('span', 'name', p.name + (p.stempelt ? ' (stempelt)' : '')), s);
        teile.push(z);
      });
      if (!(data || []).length) teile.push(el('p', 'klein', 'Noch keine Konten außer euch beiden.'));
      zgListe.replaceChildren(...teile);
    }
    zg.addEventListener('toggle', () => { if (zg.open) personenLaden(); });

    // Weitergabe an Claude
    const wg = el('details', 'bs-karte bs-formular');
    wg.append(el('summary', null, 'Automatisches Auslesen durch Claude'));
    const wgStand = el('div');
    const anleitung = el('ol', 'bs-anleitung');
    ['Am PC auf github.com anmelden (Konto ChristianAumeier).',
      'Rechts oben auf das Profilbild → Settings → ganz unten Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.',
      'Name: „Betriebs-App Fuhren“. Expiration: die längste Laufzeit wählen.',
      'Repository access: „Only select repositories“ → claude-gedaechtnis.',
      'Permissions → Repository permissions → Contents: „Read and write“. Sonst nichts.',
      'Generate token, den Schlüssel (beginnt mit github_pat_) kopieren und hier einfügen. Nicht in den Chat!'].forEach((t) => anleitung.append(el('li', null, t)));
    const tf = el('form', 'bs-formular');
    const tok = el('input'); tok.type = 'password'; tok.autocomplete = 'off'; tok.required = true; tok.placeholder = 'github_pat_…';
    const tb = el('button', 'bs-knopf', 'Schlüssel speichern'); tb.type = 'submit';
    const tm = el('div');
    tf.append(tok, tb, tm);
    tf.addEventListener('submit', async (ev) => {
      ev.preventDefault(); tb.disabled = true;
      const { error } = await window.sb.rpc('github_schluessel_setzen', { p_token: tok.value });
      tb.disabled = false;
      if (error) { tm.replaceChildren(fehlerKasten('Nicht gespeichert', error)); return; }
      tok.value = '';
      tm.replaceChildren(el('div', 'bs-hinweis ok', 'Gespeichert. Ab jetzt gehen komplette Fuhren automatisch zum Auslesen.'));
      standLaden();
    });
    wg.append(wgStand, el('p', 'klein', 'Komplette Fuhren (Lieferschein, Begleitschein, Wiegeschein) gehen in dein Cloud-Gedächtnis; dort liest Claude sie aus, trägt sie in die Monats-Excel ein und schreibt die Werte zurück. Dafür braucht die App einmal einen Schlüssel von GitHub:'), anleitung, tf);
    async function standLaden() {
      const { data } = await window.sb.from('einstellungen').select('wert, geaendert_am, geaendert_von').eq('name', 'github_schluessel_gesetzt').maybeSingle();
      wgStand.replaceChildren(el('div', 'bs-hinweis ' + (data ? 'ok' : ''), data ? 'Schlüssel hinterlegt am ' + wann(data.geaendert_am) + ' von ' + (data.geaendert_von || '?') + '.' : 'Noch kein Schlüssel hinterlegt – Fuhren werden noch nicht automatisch ausgelesen.'));
    }
    wg.addEventListener('toggle', () => { if (wg.open) standLaden(); });

    return { karten: [lp, zg, wg], auffrischen: ladestellenZeichnen };
  }

  // Konto anlegen: Fahrer oder Transportfirma
  function kontoFormular(fertig) {
    const f = el('form', 'bs-formular');
    f.append(el('h4', null, 'Neues Konto'));
    const name = el('input'); name.required = true; name.placeholder = 'Vor- und Nachname (Transportfirma: Name der Person)';
    const mail = el('input'); mail.type = 'email'; mail.required = true; mail.autocapitalize = 'off'; mail.placeholder = 'name@beispiel.de';
    const art = el('select');
    [['fahrer', 'Fahrer (stempelt auch)'], ['fahrer-ohne', 'Fahrer (stempelt nicht)'], ['transportfirma', 'Transportfirma']].forEach(([w, t]) => { const o = el('option', null, t); o.value = w; art.append(o); });
    const l1 = el('label', null, 'Name'); l1.append(name);
    const l2 = el('label', null, 'E-Mail'); l2.append(mail);
    const l3 = el('label', null, 'Zugang'); l3.append(art);
    const knopf = el('button', 'bs-knopf', 'Konto anlegen'); knopf.type = 'submit';
    const meldung = el('div');
    f.append(l1, l2, l3, knopf, meldung);
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      knopf.disabled = true;
      meldung.replaceChildren();
      const zugang = art.value === 'transportfirma' ? 'transportfirma' : 'fahrer';
      const { data, error } = await window.sb.functions.invoke('konto-anlegen', { body: { name: name.value, email: mail.value, zugang, stempelt: art.value === 'fahrer' } });
      knopf.disabled = false;
      let fehler = data && data.fehler;
      if (error && !fehler) { try { fehler = (await error.context.json()).fehler; } catch (e) { fehler = fehlerText(error); } }
      if (fehler && /already been registered/i.test(fehler)) fehler = 'Für diese E-Mail-Adresse gibt es schon ein Konto. Bitte eine andere Adresse nehmen. (' + fehler + ')';
      if (fehler) { meldung.replaceChildren(el('div', 'bs-hinweis fehler', fehler)); return; }
      const k = el('div', 'bs-hinweis ok');
      k.append(el('div', null, 'Konto angelegt für ' + name.value + ' (' + data.email + ').'),
        el('div', null, 'Vorläufiges Kennwort (nur jetzt sichtbar, bitte weitergeben):'),
        el('div', 'bs-kennwort', data.passwort),
        el('div', null, 'Anmelden unter christianaumeier.github.io/betriebs-app – beim ersten Anmelden wird der 6-stellige Code eingerichtet.'));
      meldung.replaceChildren(k);
      name.value = ''; mail.value = '';
      fertig();
    });
    return f;
  }

  // ---------- Herunterladen ----------
  function csvHerunterladen(fuhren, preise, dateiname) {
    const kopf = ['Datum', 'Ladestelle', 'Vertrag', 'Stück', 'Gewicht (t)', 'Zeit beim Abladen', 'Fahrer', 'Begleitscheinnummer', 'Auftragsnummer', 'Vergütung', 'Betrag (€)', 'Hinweis'];
    const zeilen = fuhren.filter((f) => !f.storniert_am).slice().sort((a, b) => (a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : a.id - b.id)).map((f) => {
      const p = preisFuer(preise, f);
      const b = betragFuer(preise, f);
      return [datum(f.datum), f.ladestelle || '', f.vertrag || '', f.stueck ?? '', f.gewicht_t === null ? '' : zahl(f.gewicht_t, 2), zeit(f.abladezeit).replace('–', ''),
        f.fahrer || '', f.begleitschein_nr || '', f.auftrag_nr || '', p ? preisText(p) : '', b === null ? '' : zahl(b, 2), f.hinweise || ''];
    });
    const text = [kopf].concat(zeilen).map((z) => z.map((x) => '"' + String(x).replace(/"/g, '""') + '"').join(';')).join('\r\n');
    speichernAls(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }), dateiname);
  }
  async function excelHerunterladen(monat, knopf) {
    knopf.disabled = true;
    const { data, error } = await window.sb.functions.invoke('fuhren-github', { body: { aktion: 'excel', monat } });
    knopf.disabled = false;
    let fehler = data && data.fehler;
    if (error && !fehler) { try { fehler = (await error.context.json()).fehler; } catch (e) { fehler = fehlerText(error); } }
    if (fehler) { alert(fehler); return; }
    const roh = atob(data.inhalt);
    const bytes = Uint8Array.from(roh, (c) => c.charCodeAt(0));
    speichernAls(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), data.name);
  }
  function speichernAls(blob, name) {
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function zeigeBahnschwellen(ziel, rest) {
    if (!rolle()) { ziel.replaceChildren(el('div', 'bs-hinweis', 'Für dieses Konto ist der Bereich nicht freigeschaltet.')); return; }
    Schlange.abarbeiten();
    if (rest) zeigeFuhre(ziel, rest); else zeigeListe(ziel);
  }

  window.zeigeBahnschwellen = zeigeBahnschwellen;
  window.FuhrenSchlange = Schlange;
})();
