// Melder für den Solar-Log der Biogasanlage (Portal stuber-sonne.enerest.world, Anlage „Aumeier Schierling Biogas“).
// Läuft im angemeldeten Solar-Log-Tab am Büro-PC; Claude setzt ihn per Skript in die Seite.
// Alle 5 Minuten: Leistung und Tagesertrag je Wechselrichter (5-Minuten-Werte „ProdPac“) an
// Supabase rpc/pvbga_melden (supabase/032_pv_biogas_solarlog.sql). Beim ersten Lauf ab ERSTER_TAG nachholen.
// Anmeldung: Das Portal hält sein Token selbst frisch (localStorage access_token), solange die Seite offen ist.
// Der Schlüssel liegt nur im localStorage dieses Browsers (betriebsapp_solarlog_key), nie im Repository.
(() => {
  if (window.__slm) clearInterval(window.__slm.timer);
  const ANLAGE = '1f108166-8ace-665c-9e89-7bd2a4a84ec2';
  const SUPABASE = 'https://trwazyqryqdjbfggaufd.supabase.co/rest/v1/rpc/pvbga_melden';
  const APIKEY = 'sb_publishable_9zKcwyfgNlg19tYQDpivLQ_4j_JkxOc';
  const ERSTER_TAG = window.__slmAb || '2026-10-01';   // zum Nachholen nach einem Ausfall vorher setzen
  const TAKT_MS = 5 * 60 * 1000;
  const slm = window.__slm = { log: [], nachgeholt: false };
  const notiz = (t) => { slm.log.push(new Date().toLocaleTimeString('de-DE') + ' ' + t); if (slm.log.length > 60) slm.log.shift(); };
  const tagBerlin = (d) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });

  async function api(pfad) {
    const r = await fetch(pfad, { headers: { Authorization: 'Bearer ' + localStorage.getItem('access_token') } });
    if (!r.ok) throw new Error('Solar-Log antwortet ' + r.status + ' (' + pfad.split('?')[0].split('/').pop() + ')');
    return r.json();
  }

  async function melde(daten) {
    const r = await fetch(SUPABASE, {
      method: 'POST',
      headers: { apikey: APIKEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_schluessel: localStorage.getItem('betriebsapp_solarlog_key'), p_daten: daten })
    });
    const t = await r.text();
    notiz((daten.fehler ? 'Fehler gemeldet' : 'gemeldet') + ' → ' + r.status + ' ' + t.slice(0, 80));
    return r.ok;
  }

  async function lauf() {
    const heute = tagBerlin(new Date());
    const gestern = tagBerlin(new Date(Date.now() - 86400000));
    const ab = slm.nachgeholt ? gestern : ERSTER_TAG;
    const comps = await api(`/api/datasource/v1/plant/${ANLAGE}/components?properties%5B%5D=name&properties%5B%5D=crossEpochId`
      + `&properties%5B%5D=mpptrackers&properties%5B%5D=sortOrder&from=${heute}&to=${heute}`);
    const ids = comps.map((c) => 'xComponentIds%5B%5D=' + c.crossEpochId).join('&');
    const serien = await api(`/api/visualization/v1/plant/${ANLAGE}/cross-epoch/channels?dateFrom=${ab}&dateTo=${heute}`
      + `&channelNames%5B%5D=ProdPac&${ids}`);

    // je Wechselrichter und Tag kWh aufsummieren (5-Minuten-Leistung in W), dazu der letzte Wert von heute
    const jetzt = Date.now();
    const kwh = {};     // id -> tag -> kWh
    const letzter = {}; // id -> { zeit, w }
    for (const s of serien) {
      const punkte = Object.entries(s.dataPoints || {});
      if (punkte.length < 2) continue;
      const stunden = (new Date(punkte[1][0]) - new Date(punkte[0][0])) / 3600000;
      for (const [zeit, w] of punkte) {
        const t = new Date(zeit);
        if (t.getTime() > jetzt || w === null || w === undefined) continue;
        const tag = tagBerlin(t);
        (kwh[s.deviceId] = kwh[s.deviceId] || {})[tag] = (kwh[s.deviceId][tag] || 0) + w * stunden / 1000;
        if (tag === heute && (!letzter[s.deviceId] || t > letzter[s.deviceId].zeit)) letzter[s.deviceId] = { zeit: t, w };
      }
    }

    const geraete = comps.map((c, i) => ({
      id: c.crossEpochId,
      name: c.name,
      kwp: Math.round((c.mpptrackers || []).reduce((a, m) => a + (m.size || 0), 0) / 10) / 100,
      sortierung: c.sortOrder ?? i,
      messung_am: letzter[c.crossEpochId] ? letzter[c.crossEpochId].zeit.toISOString() : null,
      leistung_w: letzter[c.crossEpochId] ? letzter[c.crossEpochId].w : null,
      heute_kwh: kwh[c.crossEpochId] && kwh[c.crossEpochId][heute] !== undefined ? Math.round(kwh[c.crossEpochId][heute] * 100) / 100 : 0
    }));
    const tage = [];
    for (const [id, proTag] of Object.entries(kwh)) {
      for (const [tag, wert] of Object.entries(proTag)) tage.push({ id, tag, kwh: Math.round(wert * 100) / 100 });
    }
    if (await melde({ geraete, tage })) slm.nachgeholt = true;
  }

  async function takt() {
    try { await lauf(); } catch (e) {
      notiz('Fehler: ' + e.message);
      try { await melde({ fehler: e.message }); } catch (e2) { /* Supabase nicht erreichbar */ }
    }
  }

  slm.lauf = lauf;
  slm.timer = setInterval(takt, TAKT_MS);
  takt();
  return 'Solar-Log-Melder gestartet';
})();
