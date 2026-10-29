// Wächter für das Bayernwerk-Kundenportal (Biogasanlage).
// Läuft im angemeldeten Chrome-Tab auf dem Büro-PC; Claude setzt ihn per Skript in die Seite.
// - jede Minute: eine Mausbewegung im Fenster vortäuschen. Das Portal (cscn-webui, ActivityWatcher)
//   meldet nach 540 s ohne mousemove/scroll/keypress/touch auf window ab; erst so ein Ereignis
//   erneuert lastActivityTimestamp UND die Anmelde-Tokens. Neu laden im Rahmen reicht nicht.
// - alle 4 min: Startseite in einem unsichtbaren Rahmen laden (Prüfung, ob noch angemeldet),
//   Lebenszeichen an Supabase (rpc/bga_portal_melden 'wachhalten')
// - einmal am Tag ab 7 Uhr: alle Lastgänge auslesen, die letzten 3 Tage an Supabase ('auslesen')
// - abgemeldet: Meldung 'abgemeldet'; Supabase schickt dann eine Push-Mitteilung (024)
// Der Schlüssel liegt nur im localStorage dieses Browsers (betriebsapp_bga_key), nie im Repository.
(() => {
  if (window.__bga) { clearInterval(window.__bga.timer); clearInterval(window.__bga.maus); }
  const SUPABASE = 'https://trwazyqryqdjbfggaufd.supabase.co/rest/v1/rpc/bga_portal_melden';
  const APIKEY = 'sb_publishable_9zKcwyfgNlg19tYQDpivLQ_4j_JkxOc';
  const TAGE = 3;
  const warte = ms => new Promise(r => setTimeout(r, ms));
  const heute = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  // nicht toLocaleString mit nur hour: das liefert auf Deutsch „11 Uhr“
  const stunde = () => Number(new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour12: false }).slice(0, 2));
  const bga = window.__bga = { log: [], abgemeldetGemeldet: false };
  const notiz = t => { bga.log.push(new Date().toLocaleTimeString('de-DE') + ' ' + t); if (bga.log.length > 60) bga.log.shift(); };

  async function melde(art, daten) {
    const r = await fetch(SUPABASE, {
      method: 'POST',
      headers: { apikey: APIKEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_schluessel: localStorage.getItem('betriebsapp_bga_key'), p_art: art, p_daten: daten || null })
    });
    const t = await r.text();
    notiz(art + ' → ' + r.status + ' ' + t.slice(0, 80));
    return r.ok;
  }

  function rahmen(id, breite, hoehe) {
    let f = document.getElementById(id);
    if (!f) {
      f = document.createElement('iframe');
      f.id = id;
      f.style.cssText = `position:fixed;width:${breite}px;height:${hoehe}px;left:-5000px;top:0;opacity:0;pointer-events:none`;
      document.body.appendChild(f);
    }
    return f;
  }

  function angemeldet() {
    return !!sessionStorage.getItem('cicAccessToken') && !/logout|auth\./.test(location.href);
  }

  async function wachhalten() {
    if (!angemeldet()) {
      if (!bga.abgemeldetGemeldet) { bga.abgemeldetGemeldet = await melde('abgemeldet', { text: 'Sitzung im Tab abgelaufen' }); }
      return;
    }
    const f = rahmen('__bga_wach', 1, 1);
    f.src = '/de/service/startseite.html?wach=' + Date.now();
    await warte(15000);
    let pfad = '';
    try { pfad = f.contentWindow.location.pathname; } catch (e) { pfad = 'fremd'; }
    if (/logout/.test(pfad) || !angemeldet()) {
      if (!bga.abgemeldetGemeldet) { bga.abgemeldetGemeldet = await melde('abgemeldet', { text: 'Portal meldet abgelaufen (' + pfad + ')' }); }
      return;
    }
    await melde('wachhalten');
  }

  function reihe(d) {
    const svg = d.querySelector('svg.highcharts-root');
    if (!svg) return null;
    const el = svg.parentElement.parentElement;
    const k = Object.keys(el).find(k => k.startsWith('__reactInternalInstance'));
    const ch = el[k].return.memoizedProps.highcharts.charts.filter(Boolean).pop();
    return ch && ch.series[0];
  }

  async function auslesen() {
    const f = rahmen('__bga_lese', 1200, 900);
    f.src = '/de/service/zaehler/lastgangvisualisierung.html?lese=' + Date.now();
    await warte(12000);
    const d = f.contentDocument, w = f.contentWindow;
    if (!d.querySelector('input[type=radio]')) { d.querySelector('.csc-navigation-header__toggle').click(); await warte(1500); }
    const anzahl = d.querySelectorAll('tr.rlm-nav-row input[type=radio]').length;
    if (!anzahl) throw new Error('keine Zähler in der Auswahl gefunden');
    // ab Mitternacht vor TAGE Tagen (ungefähr; nur volle Tage werden in Supabase summiert)
    const grenze = Date.now() - (TAGE + 1) * 86400000;
    const ergebnis = [];
    for (let i = 0; i < anzahl; i++) {
      if (!d.querySelector('input[type=radio]')) { d.querySelector('.csc-navigation-header__toggle').click(); await warte(1500); }
      const zeile = d.querySelectorAll('tr.rlm-nav-row')[i];
      const rb = zeile.querySelector('input[type=radio]');
      const zellen = [...zeile.querySelectorAll('td')].map(td => td.innerText.trim()).filter(Boolean);
      const vorher = reihe(d) && reihe(d).yData;
      const schonGewaehlt = rb.checked;
      if (!schonGewaehlt) rb.click();
      // Nach dem Klick klappt die Auswahl zu (rb hängt dann nicht mehr im Dokument):
      // fertig, wenn die Adresse den Eintrag nennt und neue Werte im Diagramm stehen.
      let s = null;
      for (let t = 0; t < 30; t++) {
        await warte(1000);
        s = reihe(d);
        if (s && s.xData.length && (schonGewaehlt || s.yData !== vorher) && decodeURIComponent(w.location.hash).includes(rb.value)) break;
      }
      if (!s) throw new Error('kein Diagramm für ' + zellen[1]);
      const werte = [];
      s.xData.forEach((x, j) => { if (x >= grenze) werte.push([x, s.yData[j]]); });
      ergebnis.push({ energieart: zellen[0], meldepunkt: zellen[1], obis: zellen[2], zaehler: (zellen[3] || '').split(/\s+/).map(z => z.replace(/^0+/, '')).join(', '), werte });
    }
    f.src = 'about:blank';
    return ergebnis;
  }

  async function tick() {
    try {
      await wachhalten();
      if (angemeldet() && stunde() >= 7 && localStorage.getItem('betriebsapp_bga_letzte') !== heute()) {
        const daten = await auslesen();
        if (await melde('auslesen', daten)) localStorage.setItem('betriebsapp_bga_letzte', heute());
      }
    } catch (e) { notiz('Fehler: ' + e.message); }
  }

  bga.auslesen = auslesen;
  bga.melde = melde;
  bga.tick = tick;
  bga.maus = setInterval(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 5 + Math.random() * 50, clientY: 5 + Math.random() * 50 })), 60 * 1000);
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 10 }));
  bga.timer = setInterval(tick, 4 * 60 * 1000);
  tick();
  return 'Wächter gestartet';
})();
