// Scannen mit der Handy-Kamera wie ein Dokumentenscanner (ähnlich DATEV Upload):
// Kamera läuft in der App → Blatt wird live erkannt und grün umrandet → bei ruhiger Hand automatische Aufnahme
// → gerade gezogen, Rand weg, aufgehellt → JPEG. Ecken lassen sich danach noch von Hand verschieben.
// Ohne Kamera-Zugriff: normale Handy-Kamera bzw. Foto auswählen, dann Ecken einstellen.
// Alles läuft im Gerät, ohne fremde Bibliotheken. window.Scanner.scannen() liefert { blob, mime } oder null.

(function () {
  const RECHEN_MAX = 2400;   // längste Seite für die Bearbeitung
  const AUS_MAX = 1800;      // längste Seite des fertigen Scans
  const QUALITAET = 0.72;

  function el(tag, klasse, text) {
    const e = document.createElement(tag);
    if (klasse) e.className = klasse;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // Dateiauswahl; muss direkt aus einem Tippen heraus aufgerufen werden (sonst blockt der Browser)
  function dateiWaehlen(accept) {
    return new Promise((fertig) => {
      const i = el('input');
      i.type = 'file';
      i.accept = accept;
      i.style.display = 'none';
      i.addEventListener('change', () => { fertig(i.files && i.files[0] ? i.files[0] : null); i.remove(); });
      i.addEventListener('cancel', () => { fertig(null); i.remove(); });
      document.body.append(i);
      i.click();
    });
  }

  function bildLaden(datei) {
    return new Promise((ok, fehler) => {
      const url = URL.createObjectURL(datei);
      const img = new Image();
      img.onload = () => { ok(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
      img.onerror = () => { URL.revokeObjectURL(url); fehler(new Error('Das Bild konnte nicht geöffnet werden.')); };
      img.src = url;
    });
  }

  function leinwand(b, h) { const c = el('canvas'); c.width = b; c.height = h; return c; }

  // ---------- Blatt erkennen ----------
  // Verkleinert, Helligkeitsschwelle (Otsu), größte helle Fläche, deren äußerste Punkte = Ecken.
  // Liefert die Ecken (in Pixeln der Quelle) oder null, wenn kein Blatt sicher erkannt ist.
  // quelle darf ein Bild, eine Leinwand oder das laufende Kamerabild (video) sein.
  let suchLeinwand = null;
  function blattSuchen(quelle, qb, qh, breite) {
    qb = qb || quelle.width; qh = qh || quelle.height;
    const b = breite || 240, h = Math.round(qh * b / qb);
    if (!suchLeinwand) suchLeinwand = leinwand(b, h);
    const c = suchLeinwand;
    if (c.width !== b || c.height !== h) { c.width = b; c.height = h; }
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(quelle, 0, 0, b, h);
    const d = cx.getImageData(0, 0, b, h).data;
    const grau = new Uint8Array(b * h);
    const hist = new Array(256).fill(0);
    for (let i = 0; i < b * h; i++) {
      const g = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) | 0;
      grau[i] = g; hist[g]++;
    }
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sB = 0, wB = 0, best = 0, schwelle = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = b * h - wB; if (!wF) break;
      sB += i * hist[i];
      const mB = sB / wB, mF = (sum - sB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; schwelle = i; }
    }
    const marke = new Int32Array(b * h).fill(-1);
    let groesste = null, groesse = 0;
    const stapel = new Int32Array(b * h);
    for (let start = 0; start < b * h; start++) {
      if (marke[start] !== -1 || grau[start] <= schwelle) continue;
      let n = 0, oben = 0;
      stapel[oben++] = start; marke[start] = start;
      const punkte = [];
      while (oben) {
        const p = stapel[--oben]; n++; punkte.push(p);
        const x = p % b, y = (p / b) | 0;
        const nach = [x > 0 ? p - 1 : -1, x < b - 1 ? p + 1 : -1, y > 0 ? p - b : -1, y < h - 1 ? p + b : -1];
        for (const q of nach) if (q >= 0 && marke[q] === -1 && grau[q] > schwelle) { marke[q] = start; stapel[oben++] = q; }
      }
      if (n > groesse) { groesse = n; groesste = punkte; }
    }
    const f = qb / b;
    if (!groesste || groesse < b * h * 0.12) return null;
    let lo = null, ro = null, ru = null, lu = null;
    let minX = b, maxX = 0, minY = h, maxY = 0;
    for (const p of groesste) {
      const x = p % b, y = (p / b) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (!lo || x + y < lo[0] + lo[1]) lo = [x, y];
      if (!ru || x + y > ru[0] + ru[1]) ru = [x, y];
      if (!ro || x - y > ro[0] - ro[1]) ro = [x, y];
      if (!lu || y - x > lu[1] - lu[0]) lu = [x, y];
    }
    // Plausibel? Nicht das ganze Bild (z. B. heller Himmel) und die Fläche füllt das Viereck fast ganz aus (= rechteckig)
    if (maxX - minX > b * 0.985 && maxY - minY > h * 0.985) return null;
    const q = [lo, ro, ru, lu];
    let flaeche = 0;
    for (let i = 0; i < 4; i++) { const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4]; flaeche += x1 * y2 - x2 * y1; }
    flaeche = Math.abs(flaeche) / 2;
    if (flaeche < b * h * 0.12 || groesse / flaeche < 0.8) return null;
    return q.map(([x, y]) => [(x + 0.5) * f, (y + 0.5) * f]);
  }
  function eckenFinden(quelle) {
    const e = blattSuchen(quelle);
    if (e) return e;
    const r = 0.05;
    return [[r, r], [1 - r, r], [1 - r, 1 - r], [r, 1 - r]].map(([x, y]) => [x * quelle.width, y * quelle.height]);
  }

  // ---------- Gerade ziehen ----------
  // Projektive Abbildung Zielrechteck → Viereck im Foto (8 Unbekannte, Gauß-Verfahren)
  function abbildung(von, nach) {
    const A = [], B = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = von[i], [u, v] = nach[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); B.push(v);
    }
    for (let i = 0; i < 8; i++) {
      let m = i;
      for (let j = i + 1; j < 8; j++) if (Math.abs(A[j][i]) > Math.abs(A[m][i])) m = j;
      [A[i], A[m]] = [A[m], A[i]]; [B[i], B[m]] = [B[m], B[i]];
      for (let j = i + 1; j < 8; j++) {
        const k = A[j][i] / A[i][i];
        for (let l = i; l < 8; l++) A[j][l] -= k * A[i][l];
        B[j] -= k * B[i];
      }
    }
    const h = new Array(8);
    for (let i = 7; i >= 0; i--) {
      let s = B[i];
      for (let j = i + 1; j < 8; j++) s -= A[i][j] * h[j];
      h[i] = s / A[i][i];
    }
    return h;
  }

  function abstand(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  function geradeZiehen(quelle, ecken, dokument) {
    let breite = Math.max(abstand(ecken[0], ecken[1]), abstand(ecken[3], ecken[2]));
    let hoehe = Math.max(abstand(ecken[0], ecken[3]), abstand(ecken[1], ecken[2]));
    const f = Math.min(1, AUS_MAX / Math.max(breite, hoehe));
    breite = Math.round(breite * f); hoehe = Math.round(hoehe * f);
    const qc = leinwand(quelle.width, quelle.height);
    const qx = qc.getContext('2d', { willReadFrequently: true });
    qx.drawImage(quelle, 0, 0);
    const q = qx.getImageData(0, 0, quelle.width, quelle.height).data;
    const qb = quelle.width, qh = quelle.height;
    const z = leinwand(breite, hoehe);
    const zx = z.getContext('2d');
    const bild = zx.createImageData(breite, hoehe);
    const o = bild.data;
    const h = abbildung([[0, 0], [breite, 0], [breite, hoehe], [0, hoehe]], ecken);
    for (let y = 0; y < hoehe; y++) {
      for (let x = 0; x < breite; x++) {
        const w = h[6] * x + h[7] * y + 1;
        const u = Math.min(qb - 1, Math.max(0, ((h[0] * x + h[1] * y + h[2]) / w) | 0));
        const v = Math.min(qh - 1, Math.max(0, ((h[3] * x + h[4] * y + h[5]) / w) | 0));
        const s = (v * qb + u) * 4, t = (y * breite + x) * 4;
        o[t] = q[s]; o[t + 1] = q[s + 1]; o[t + 2] = q[s + 2]; o[t + 3] = 255;
      }
    }
    if (dokument) aufhellen(o, breite, hoehe);
    zx.putImageData(bild, 0, 0);
    return z;
  }

  // Dokument-Look: Hintergrund (Papier inkl. Schatten) je Block schätzen, herausrechnen, Kontrast anheben.
  // Farbe bleibt erhalten (Kuli blau, Stempel rot), nur heller und klarer.
  function aufhellen(o, b, h) {
    const B = 24, nb = Math.ceil(b / B), nh = Math.ceil(h / B);
    const hg = new Float32Array(nb * nh);
    for (let by = 0; by < nh; by++) for (let bx = 0; bx < nb; bx++) {
      const werte = [];
      for (let y = by * B; y < Math.min(h, by * B + B); y += 3) for (let x = bx * B; x < Math.min(b, bx * B + B); x += 3) {
        const i = (y * b + x) * 4;
        werte.push(o[i] * 0.299 + o[i + 1] * 0.587 + o[i + 2] * 0.114);
      }
      werte.sort((a, c) => a - c);
      hg[by * nb + bx] = werte[Math.floor(werte.length * 0.9)] || 255;
    }
    // glätten
    const g2 = new Float32Array(nb * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nb; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < nh && xx >= 0 && xx < nb) { s += hg[yy * nb + xx]; n++; }
      }
      g2[y * nb + x] = Math.max(60, s / n);
    }
    for (let y = 0; y < h; y++) {
      const fy = Math.min(nh - 1, Math.max(0, y / B - 0.5));
      const y0 = Math.floor(fy), y1 = Math.min(nh - 1, y0 + 1), ay = fy - y0;
      for (let x = 0; x < b; x++) {
        const fx = Math.min(nb - 1, Math.max(0, x / B - 0.5));
        const x0 = Math.floor(fx), x1 = Math.min(nb - 1, x0 + 1), ax = fx - x0;
        const bg = (g2[y0 * nb + x0] * (1 - ax) + g2[y0 * nb + x1] * ax) * (1 - ay) + (g2[y1 * nb + x0] * (1 - ax) + g2[y1 * nb + x1] * ax) * ay;
        const i = (y * b + x) * 4;
        for (let k = 0; k < 3; k++) {
          let v = o[i + k] / bg * 255;              // Papier → weiß
          v = (v - 40) * 1.2;                       // Schrift dunkler
          o[i + k] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
    }
  }

  // ---------- Bearbeiten-Ansicht ----------
  function bearbeiten(quelle, eckenStart) {
    return new Promise((fertig) => {
      const huelle = el('div', 'sc-huelle');
      const kopf = el('div', 'sc-kopf', 'Ecken auf die Blattecken ziehen');
      const buehne = el('div', 'sc-buehne');
      const bildC = leinwand(1, 1);
      const linien = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      linien.setAttribute('class', 'sc-linien');
      const viereck = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      linien.append(viereck);
      buehne.append(bildC, linien);
      const knoepfe = el('div', 'sc-knoepfe');
      const abbrechen = el('button', 'sc-knopf leise', 'Abbrechen');
      const ganz = el('button', 'sc-knopf leise', 'Ganzes Bild');
      const ok = el('button', 'sc-knopf', 'Fertig');
      knoepfe.append(abbrechen, ganz, ok);
      huelle.append(kopf, buehne, knoepfe);
      document.body.append(huelle);
      document.body.classList.add('sc-offen');

      let ecken = eckenStart ? eckenStart.map((p) => p.slice()) : eckenFinden(quelle);
      let massstab = 1;
      const griffe = ecken.map(() => { const g = el('div', 'sc-griff'); buehne.append(g); return g; });

      function zeichnen() {
        const platzB = buehne.clientWidth, platzH = buehne.clientHeight;
        massstab = Math.min(platzB / quelle.width, platzH / quelle.height);
        const b = Math.round(quelle.width * massstab), h = Math.round(quelle.height * massstab);
        bildC.width = b; bildC.height = h;
        bildC.getContext('2d').drawImage(quelle, 0, 0, b, h);
        const links = (platzB - b) / 2, oben = (platzH - h) / 2;
        bildC.style.left = links + 'px'; bildC.style.top = oben + 'px';
        linien.setAttribute('width', platzB); linien.setAttribute('height', platzH);
        viereck.setAttribute('points', ecken.map(([x, y]) => (links + x * massstab) + ',' + (oben + y * massstab)).join(' '));
        griffe.forEach((g, i) => { g.style.left = (links + ecken[i][0] * massstab) + 'px'; g.style.top = (oben + ecken[i][1] * massstab) + 'px'; });
      }
      griffe.forEach((g, i) => {
        g.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          g.setPointerCapture(e.pointerId);
          const r = bildC.getBoundingClientRect();
          const bewegen = (ev) => {
            ecken[i] = [Math.min(quelle.width, Math.max(0, (ev.clientX - r.left) / massstab)),
                        Math.min(quelle.height, Math.max(0, (ev.clientY - r.top) / massstab))];
            zeichnen();
          };
          const los = () => { g.removeEventListener('pointermove', bewegen); g.removeEventListener('pointerup', los); g.removeEventListener('pointercancel', los); };
          g.addEventListener('pointermove', bewegen);
          g.addEventListener('pointerup', los);
          g.addEventListener('pointercancel', los);
        });
      });
      const neu = () => zeichnen();
      window.addEventListener('resize', neu);
      function schliessen(ergebnis) {
        window.removeEventListener('resize', neu);
        document.body.classList.remove('sc-offen');
        huelle.remove();
        fertig(ergebnis);
      }
      abbrechen.addEventListener('click', () => schliessen(null));
      ganz.addEventListener('click', () => { ecken = [[0, 0], [quelle.width, 0], [quelle.width, quelle.height], [0, quelle.height]]; zeichnen(); });
      ok.addEventListener('click', () => {
        ok.disabled = true; ok.textContent = 'Wird bearbeitet …';
        setTimeout(() => {
          const c = geradeZiehen(quelle, ecken, true);
          c.toBlob((blob) => schliessen(blob ? { blob, mime: 'image/jpeg', breite: c.width, hoehe: c.height } : null), 'image/jpeg', QUALITAET);
        }, 30);
      });
      requestAnimationFrame(zeichnen);
    });
  }

  // ---------- Live-Scanner (wie DATEV Upload) ----------
  // Kamera läuft in der App, das Blatt wird laufend erkannt und grün umrandet. Liegt der Rahmen
  // etwa eine Sekunde ruhig, löst die App selbst aus (oder Knopf drücken). Danach Vorschau des
  // zugeschnittenen Scans: Übernehmen, Ecken anpassen oder neu aufnehmen.
  const RUHIG_BILDER = 7;      // so viele Erkennungen hintereinander fast ohne Bewegung → auslösen
  const RUHIG_ABWEICHUNG = 0.02;

  function live() {
    return new Promise((fertig) => {
      const huelle = el('div', 'sc-huelle');
      const kopf = el('div', 'sc-kopf', 'Kamera wird gestartet …');
      const buehne = el('div', 'sc-buehne');
      const video = el('video', 'sc-video');
      video.setAttribute('playsinline', ''); video.setAttribute('muted', ''); video.muted = true; video.autoplay = true;
      const linien = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      linien.setAttribute('class', 'sc-linien');
      const viereck = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      linien.append(viereck);
      buehne.append(video, linien);
      const knoepfe = el('div', 'sc-knoepfe');
      const abbrechen = el('button', 'sc-knopf leise', 'Abbrechen');
      const ausloeser = el('button', 'sc-ausloeser'); ausloeser.setAttribute('aria-label', 'Aufnehmen');
      const auto = el('button', 'sc-knopf leise', 'Auto: an');
      knoepfe.append(abbrechen, ausloeser, auto);
      huelle.append(kopf, buehne, knoepfe);
      document.body.append(huelle);
      document.body.classList.add('sc-offen');

      let strom = null, laeuft = true, automatisch = true, takt = null;
      let ecken = null, zuletzt = null, verlauf = [];
      let vw = 0, vh = 0;

      function aufraeumen() {
        laeuft = false;
        clearTimeout(takt);
        if (strom) strom.getTracks().forEach((t) => t.stop());
        document.body.classList.remove('sc-offen');
        huelle.remove();
      }
      function schliessen(e) { aufraeumen(); fertig(e); }
      abbrechen.addEventListener('click', () => schliessen(null));
      auto.addEventListener('click', () => { automatisch = !automatisch; auto.textContent = 'Auto: ' + (automatisch ? 'an' : 'aus'); verlauf = []; });

      // Ohne Kamera-Zugriff: normale Kamera/Fotos des Handys, danach Ecken einstellen
      function ohneLive(grund) {
        laeuft = false;
        kopf.textContent = grund;
        const k = el('button', 'sc-knopf', 'Kamera des Handys öffnen');
        k.addEventListener('click', async () => {
          const f = await dateiWaehlen('image/*');
          if (!f) return;
          aufraeumen();
          fertig(await ausDatei(f));
        });
        knoepfe.replaceChildren(abbrechen, k);
      }

      // Anzeige: Kamerabild „contain“ in der Bühne → Umrechnung Kamera-Pixel → Bildschirm
      function massstab() {
        const bb = buehne.clientWidth, bh = buehne.clientHeight;
        const m = Math.min(bb / vw, bh / vh);
        return { m, x: (bb - vw * m) / 2, y: (bh - vh * m) / 2, bb, bh };
      }
      function rahmen(stabil) {
        const s = massstab();
        linien.setAttribute('width', s.bb); linien.setAttribute('height', s.bh);
        if (!ecken) { viereck.setAttribute('points', ''); return; }
        viereck.setAttribute('points', ecken.map(([x, y]) => (s.x + x * s.m) + ',' + (s.y + y * s.m)).join(' '));
        viereck.setAttribute('class', stabil ? 'stabil' : '');
      }

      function erkennen() {
        if (!laeuft) return;
        if (video.readyState >= 2 && video.videoWidth) {
          vw = video.videoWidth; vh = video.videoHeight;
          const neu = blattSuchen(video, vw, vh, 200);
          if (neu) {
            // Ruhe prüfen: größte Eckbewegung im Verhältnis zur Bildbreite
            const bewegung = ecken ? Math.max(...neu.map((p, i) => Math.hypot(p[0] - ecken[i][0], p[1] - ecken[i][1]))) / vw : 1;
            ecken = ecken ? neu.map((p, i) => [(p[0] + ecken[i][0]) / 2, (p[1] + ecken[i][1]) / 2]) : neu;
            zuletzt = neu; // für die Aufnahme die neueste Erkennung (der Rahmen auf dem Bildschirm ist geglättet)
            verlauf.push(bewegung < RUHIG_ABWEICHUNG);
            if (verlauf.length > RUHIG_BILDER) verlauf.shift();
            const ruhig = verlauf.length === RUHIG_BILDER && verlauf.every(Boolean);
            kopf.textContent = automatisch ? (ruhig ? 'Aufnahme …' : 'Blatt erkannt – bitte ruhig halten') : 'Blatt erkannt – zum Aufnehmen tippen';
            rahmen(ruhig);
            if (ruhig && automatisch) { aufnehmen(); return; }
          } else {
            ecken = null; zuletzt = null; verlauf = [];
            kopf.textContent = 'Dokument ins Bild halten (dunkler Untergrund hilft)';
            rahmen(false);
          }
        }
        takt = setTimeout(erkennen, 120);
      }

      async function aufnehmen() {
        if (!vw) return;
        laeuft = false;
        clearTimeout(takt);
        const bild = leinwand(vw, vh);
        bild.getContext('2d').drawImage(video, 0, 0, vw, vh);
        // Beim Auslösen frisch suchen (genau dieses Bild); sonst letzte Erkennung; sonst ganzes Bild
        const e = blattSuchen(bild, vw, vh, 320) || (zuletzt || ecken || [[0, 0], [vw, 0], [vw, vh], [0, vh]]).map((p) => p.slice());
        if (navigator.vibrate) navigator.vibrate(40);
        vorschau(bild, e);
      }
      ausloeser.addEventListener('click', aufnehmen);

      // Vorschau des zugeschnittenen Scans
      function vorschau(bild, e) {
        kopf.textContent = 'Wird zugeschnitten …';
        setTimeout(() => {
          const c = geradeZiehen(bild, e, true);
          c.toBlob((blob) => {
            const url = URL.createObjectURL(blob);
            const img = el('img', 'sc-ergebnis'); img.src = url;
            buehne.replaceChildren(img);
            kopf.textContent = 'So sieht der Scan aus';
            const nochmal = el('button', 'sc-knopf leise', 'Neu');
            const anpassen = el('button', 'sc-knopf leise', 'Ecken anpassen');
            const ok = el('button', 'sc-knopf', 'Übernehmen');
            knoepfe.replaceChildren(nochmal, anpassen, ok);
            ok.addEventListener('click', () => { URL.revokeObjectURL(url); schliessen({ blob, mime: 'image/jpeg', breite: c.width, hoehe: c.height }); });
            nochmal.addEventListener('click', () => {
              URL.revokeObjectURL(url);
              buehne.replaceChildren(video, linien);
              knoepfe.replaceChildren(abbrechen, ausloeser, auto);
              ecken = null; zuletzt = null; verlauf = []; laeuft = true;
              video.play().catch(() => {});
              erkennen();
            });
            anpassen.addEventListener('click', async () => {
              URL.revokeObjectURL(url);
              huelle.style.display = 'none';
              const r = await bearbeiten(bild, e);
              if (r) { schliessen(r); return; }
              huelle.style.display = '';
              document.body.classList.add('sc-offen');
              vorschau(bild, e);
            });
          }, 'image/jpeg', QUALITAET);
        }, 30);
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        ohneLive('Dieses Gerät erlaubt keine Kamera in der App.');
        return;
      }
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1920 } }
      }).then((s) => {
        strom = s;
        if (!huelle.isConnected) { aufraeumen(); return; }
        video.srcObject = s;
        return video.play().then(() => { kopf.textContent = 'Dokument ins Bild halten'; erkennen(); });
      }).catch((e) => {
        ohneLive('Kamera nicht verfügbar (' + (e && e.name === 'NotAllowedError' ? 'nicht erlaubt – in den Einstellungen des Handys bei der App „Kamera“ erlauben' : fehlerName(e)) + ').');
      });
    });
  }
  function fehlerName(e) { return (e && (e.message || e.name)) || String(e); }

  async function ausDatei(f) {
    const img = await bildLaden(f);
    const m = Math.min(1, RECHEN_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const c = leinwand(Math.round(img.naturalWidth * m), Math.round(img.naturalHeight * m));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return bearbeiten(c);
  }

  // Scannen: mit Datei (z. B. aus Fotos) → Ecken einstellen; sonst Live-Scanner mit Kamera
  async function scannen(datei) {
    if (datei) return ausDatei(datei);
    return live();
  }

  window.Scanner = { scannen, dateiWaehlen, blattSuchen };
})();
