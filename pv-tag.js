// Datumsleiste für die PV-Bereiche („PV Stockhalle“, „PV Biogasanlage“), wie bei „Tätigkeiten“ (stempeln.js):
// ‹ › tageweise zurück und vor, in der Mitte das Datum, „Zu heute“ wenn weiter zurück als gestern.
// Christian, 07.11.2026: „Kann ich auch den Tag zum Blättern haben oben?“
// Für vergangene Tage gibt es nur Tageswerte (kWh), keine Leistung „jetzt“ (Live-Werte werden nicht aufgehoben).

(function () {
  function tagBerlin(d) { return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }); }
  function tagPlus(tag, n) {
    const [j, m, t] = tag.split('-').map(Number);
    const d = new Date(Date.UTC(j, m - 1, t + n));
    return d.toISOString().slice(0, 10);
  }
  function el(tag, klasse, text) {
    const e = document.createElement(tag);
    if (klasse) e.className = klasse;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // beiWechsel(tag) wird nach jedem Blättern aufgerufen; tag = JJJJ-MM-TT (deutsche Zeit)
  function leiste(beiWechsel) {
    const box = el('div', 'pv-tagleiste');
    const zur = el('button', 'pfeil', '‹'); zur.setAttribute('aria-label', 'Einen Tag zurück');
    const vor = el('button', 'pfeil', '›'); vor.setAttribute('aria-label', 'Einen Tag vor');
    const mitte = el('div', 'mitte');
    const datum = el('div', 'datum');
    const unter = el('div', 'unter');
    const heuteKnopf = el('button', 'heute', 'Zu heute');
    mitte.append(datum, unter, heuteKnopf);
    box.append(zur, mitte, vor);
    let tag = tagBerlin(new Date());

    function kopf() {
      const heute = tagBerlin(new Date());
      const [j, m, t] = tag.split('-').map(Number);
      datum.textContent = new Date(j, m - 1, t).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
      const zusatz = tag === heute ? 'heute' : tag === tagPlus(heute, -1) ? 'gestern' : '';
      unter.textContent = zusatz;
      unter.style.display = zusatz ? '' : 'none';
      vor.disabled = tag >= heute;
      heuteKnopf.style.display = tag < tagPlus(heute, -1) ? '' : 'none';
    }
    function blaettern(neu) {
      if (neu > tagBerlin(new Date())) return;
      tag = neu;
      kopf();
      beiWechsel(tag);
    }
    zur.addEventListener('click', () => blaettern(tagPlus(tag, -1)));
    vor.addEventListener('click', () => blaettern(tagPlus(tag, 1)));
    heuteKnopf.addEventListener('click', () => blaettern(tagBerlin(new Date())));
    kopf();
    return { element: box, tag: () => tag, istHeute: () => tag === tagBerlin(new Date()) };
  }

  window.PvTag = { leiste, tagBerlin, tagPlus };
})();
