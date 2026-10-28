// Bereich „Stempeln“: Arbeitszeiten der Mitarbeiter (supabase/010_stempeln.sql).
// Mitarbeiter: Start, Pause, Weiter, Stopp; vergessene Zeiten nachtragen (wartet auf Freigabe);
// kurz eintragen, was am Tag gemacht wurde (supabase/011_taetigkeiten.sql).
// Chef (Christian, Carolin): wer gerade arbeitet, Nachträge freigeben, Stunden je Monat, Liste fürs Lohnbüro,
// Konten für Mitarbeiter anlegen (Edge Function konto-anlegen).
// Stempel werden nie gelöscht oder geändert; die Zeit beim Knopfdruck setzt der Server.

(function () {
  const ABFRAGE_MS = 60000;
  const ARTEN = { start: 'Start', pause: 'Pause', weiter: 'Pause beenden', stopp: 'Stopp' };
  const ABWESEND = { urlaub: 'Urlaub', krank: 'Krank', frei: 'Frei' }; // supabase/019_urlaub.sql

  function el(tag, klasse, text) {
    const e = document.createElement(tag);
    if (klasse) e.className = klasse;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function fehlerText(e) {
    return (e && e.message) ? e.message + (e.code ? ' (' + e.code + ')' : '') : String(e);
  }
  function fehlerKasten(text, e) { return el('div', 'st-hinweis fehler', text + ': ' + fehlerText(e)); }
  // Kalendertag in deutscher Zeit als „2026-10-24“
  function tagVon(d) { return new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }); }
  function uhr(d) { return new Date(d).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }); }
  function datumKurz(tag) {
    const [j, m, t] = tag.split('-').map(Number);
    return new Date(j, m - 1, t).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
  }
  function wannText(d) {
    return (tagVon(d) === tagVon(new Date()) ? 'heute' : datumKurz(tagVon(d))) + ' ' + uhr(d) + ' Uhr';
  }
  function stunden(ms) {
    const min = Math.round(ms / 60000);
    return Math.floor(min / 60) + ':' + String(min % 60).padStart(2, '0') + ' Std.';
  }
  function dezimal(ms) { return (Math.round(ms / 36000) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2 }); }
  function monatName(j, m) { return new Date(j, m, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }); }

  // Zustand aus den Stempeln (wie in der Datenbank: letzter nicht abgelehnter Stempel)
  function zustand(stempel) {
    const jetzt = Date.now();
    const s = stempel.filter((x) => x.status !== 'abgelehnt' && new Date(x.zeit).getTime() <= jetzt)
      .sort((a, b) => new Date(a.zeit) - new Date(b.zeit) || a.id - b.id).pop();
    if (!s || s.art === 'stopp') return { art: 'aus', seit: s ? s.zeit : null };
    return { art: s.art === 'pause' ? 'pause' : 'arbeitet', seit: s.zeit };
  }

  // Stempel einer Person → Tage mit Beginn, Ende, Pause, Arbeitszeit.
  // Eine Schicht zählt zu dem Tag, an dem sie begonnen hat.
  function auswerten(stempel) {
    const tage = {};
    const liste = stempel.filter((x) => x.status !== 'abgelehnt')
      .sort((a, b) => new Date(a.zeit) - new Date(b.zeit) || a.id - b.id);
    let z = 'aus', tag = null, abschnitt = 0, pauseAb = 0;
    function zu(s) {
      const t = tagVon(s.zeit);
      if (!tage[t]) tage[t] = { tag: t, beginn: s.zeit, ende: null, arbeitMs: 0, pauseMs: 0, nachtrag: false, offen: false, stoppFehlt: false, laeuft: false, schichten: 0 };
      return tage[t];
    }
    for (const s of liste) {
      const ms = new Date(s.zeit).getTime();
      if (s.art === 'start' || (s.art === 'weiter' && z === 'aus')) {
        if (z !== 'aus' && tag) tag.stoppFehlt = true;
        tag = zu(s); tag.schichten++; z = 'arbeitet'; abschnitt = ms;
      } else if (!tag) {
        continue; // Pause/Stopp ohne Start davor
      } else if (s.art === 'pause' && z === 'arbeitet') {
        tag.arbeitMs += ms - abschnitt; pauseAb = ms; z = 'pause';
      } else if (s.art === 'weiter' && z === 'pause') {
        tag.pauseMs += ms - pauseAb; abschnitt = ms; z = 'arbeitet';
      } else if (s.art === 'stopp' && z !== 'aus') {
        if (z === 'arbeitet') tag.arbeitMs += ms - abschnitt; else tag.pauseMs += ms - pauseAb;
        tag.ende = s.zeit; z = 'aus';
      }
      if (s.nachtrag) tag.nachtrag = true;
      if (s.status === 'offen') tag.offen = true;
    }
    if (z !== 'aus' && tag) {
      if (tag.tag === tagVon(new Date())) {
        tag.laeuft = true;
        if (z === 'arbeitet') tag.arbeitMs += Date.now() - abschnitt; else tag.pauseMs += Date.now() - pauseAb;
      } else {
        tag.stoppFehlt = true;
      }
    }
    return Object.values(tage).sort((a, b) => (a.tag < b.tag ? -1 : 1));
  }

  // Tätigkeiten → { 'user|2026-10-24': 'Text' }, die neueste Eintragung je Tag gilt
  function taetigkeitenNach(liste) {
    const m = {};
    liste.slice().sort((a, b) => a.id - b.id).forEach((x) => { m[x.user_id + '|' + x.tag] = x.text; });
    return m;
  }

  function tagesZeile(t, taetigkeit) {
    const z = el('div', 'st-tag' + (t.stoppFehlt ? ' warnung' : ''));
    const zeit = uhr(t.beginn) + ' – ' + (t.ende ? uhr(t.ende) : t.laeuft ? 'läuft' : '?');
    z.append(el('span', 'datum', datumKurz(t.tag)), el('span', 'zeit', zeit),
      el('span', 'pause', t.pauseMs ? 'Pause ' + stunden(t.pauseMs).replace(' Std.', '') : ''),
      el('span', 'std', stunden(t.arbeitMs)));
    const marken = [];
    if (t.stoppFehlt) marken.push('Stopp fehlt');
    if (t.schichten > 1) marken.push(t.schichten + '× gestartet (Unterbrechung zählt nicht)');
    if (t.offen) marken.push('Nachtrag wartet auf Freigabe');
    else if (t.nachtrag) marken.push('mit Nachtrag');
    if (marken.length) z.append(el('span', 'marke', marken.join(' · ')));
    if (taetigkeit) z.append(el('span', 'taetigkeit', taetigkeit));
    return z;
  }

  // Formular „Zeit nachtragen“; personen = null → für sich selbst
  // Eingeklappt, damit im Alltag nur die Knöpfe zu sehen sind
  function nachtragFormular(personen, fertig, db) {
    const sb = db || window.sb;
    const d = el('details', 'st-karte st-formular');
    d.append(el('summary', null, personen ? 'Zeit für jemanden eintragen' : 'Vergessen zu stempeln? Hier nachtragen'));
    const f = el('form', 'st');
    d.append(f);
    f.append(el('p', 'klein', personen ? 'Gilt sofort und wird als Nachtrag markiert.' : 'Der Nachtrag gilt, sobald Christian ihn freigibt.'));
    let wer = null;
    if (personen) {
      wer = el('select');
      personen.forEach((p) => { const o = el('option', null, p.name); o.value = p.user_id; wer.append(o); });
      const l = el('label', null, 'Wer'); l.append(wer); f.append(l);
    }
    const art = el('select');
    Object.entries(ARTEN).forEach(([k, v]) => { const o = el('option', null, v); o.value = k; art.append(o); });
    const datum = el('input'); datum.type = 'date'; datum.value = tagVon(new Date()); datum.required = true;
    const zeit = el('input'); zeit.type = 'time'; zeit.required = true;
    const grund = el('input'); grund.type = 'text'; grund.required = true; grund.placeholder = 'z. B. Stopp vergessen';
    [['Was', art], ['Tag', datum], ['Uhrzeit', zeit], ['Grund', grund]].forEach(([t, feld]) => {
      const l = el('label', null, t); l.append(feld); f.append(l);
    });
    // Mitarbeiter, der den Stopp nachträgt: auch eintragen, was an dem Tag gemacht wurde
    const taetigkeit = el('textarea'); taetigkeit.rows = 2; taetigkeit.maxLength = 500;
    taetigkeit.placeholder = 'z. B. meißeliert, Maschinen gewaschen';
    const lt = el('label', null, 'Was hast du an dem Tag gemacht?'); lt.append(taetigkeit);
    if (!personen) {
      f.append(lt);
      const zeigen = () => { const ja = art.value === 'stopp'; lt.style.display = ja ? '' : 'none'; taetigkeit.required = ja; };
      art.addEventListener('change', zeigen);
      zeigen();
    }
    const knopf = el('button', null, personen ? 'Eintragen' : 'Nachtrag senden'); knopf.type = 'submit';
    const meldung = el('div');
    f.append(knopf, meldung);
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      knopf.disabled = true;
      meldung.replaceChildren();
      const wann = new Date(datum.value + 'T' + zeit.value);
      if (!personen && art.value === 'stopp') {
        const t = await sb.rpc('taetigkeit_speichern', { p_tag: datum.value, p_text: taetigkeit.value });
        if (t.error) { knopf.disabled = false; meldung.replaceChildren(fehlerKasten('Nicht gespeichert', t.error)); return; }
      }
      const { error } = await sb.rpc('stempel_nachtragen', {
        p_art: art.value, p_zeit: wann.toISOString(), p_grund: grund.value, p_user: wer ? wer.value : null
      });
      knopf.disabled = false;
      if (error) { meldung.replaceChildren(fehlerKasten('Nicht gespeichert', error)); return; }
      grund.value = ''; zeit.value = ''; taetigkeit.value = '';
      meldung.replaceChildren(el('div', 'st-hinweis ok', personen ? 'Eingetragen.' : 'Gesendet. Wartet auf Freigabe.'));
      fertig();
    });
    return d;
  }

  // Wiederholt laden, solange die Ansicht offen und sichtbar ist
  function regelmaessig(box, holen) {
    const abfrage = setInterval(() => {
      if (!box.isConnected) aufhoeren(); else if (!document.hidden) holen();
    }, ABFRAGE_MS);
    function sichtbar() { if (!box.isConnected) aufhoeren(); else if (!document.hidden) holen(); }
    document.addEventListener('visibilitychange', sichtbar);
    function aufhoeren() { clearInterval(abfrage); document.removeEventListener('visibilitychange', sichtbar); }
    holen();
  }

  // ---------- Mitarbeiter ----------
  // Oben nur der Zustand und die Knöpfe; die Uhrzeit setzt beim Drücken der Server.
  // Vor dem Stopp muss eingetragen sein, was an dem Arbeitstag gemacht wurde.
  // db = Datenquelle; ohne Angabe die echte Datenbank, sonst die Vorschau (siehe vorschauDb)
  function zeigeMitarbeiter(ziel, db) {
    const sb = db || window.sb;
    const box = el('div', 'st');
    const oben = el('div', 'st');
    const liste = el('div', 'st');
    let uid = null;
    let taetigkeiten = {};
    let schichtTag = null;      // Tag, an dem die laufende Schicht begann
    let stoppFragen = false;    // Feld „Was hast du gemacht?“ ist offen
    let pauseSeit = null;       // Beginn der laufenden Pause
    let gesperrt = false;       // nach einem Tipp kurz gesperrt, damit doppeltes Tippen nicht den nächsten Knopf trifft
    // Urlaub/Frei/Krank (022): nur für Festangestellte
    let person = null, start = null, abwesend = [];
    let offen = [];             // Werktage ohne Stempel und ohne Eintrag, die der Mitarbeiter selbst klären darf
    let fragen = false;         // Nachfrage zu offenen Tagen vor dem Start ist offen
    let spaeter = false;        // „Später“ gewählt: einmal ohne Nachfrage starten
    let arbeit = null;          // offenes Formular „Gearbeitet“ { tag, f }
    const fragMeldung = el('div');
    const stopp = stoppFormular();
    const vorab = vorabFormular();
    box.append(oben, nachtragFormular(null, () => holen(), sb), liste);
    ziel.replaceChildren(box);
    let laeuft = false;

    // Für einen offenen Tag nachtragen, dass gearbeitet wurde (Nachträge warten auf Freigabe)
    function arbeitFormular(tag) {
      const f = el('form', 'st st-formular');
      const von = el('input'); von.type = 'time'; von.required = true;
      const bis = el('input'); bis.type = 'time'; bis.required = true;
      const pv = el('input'); pv.type = 'time';
      const pb = el('input'); pb.type = 'time';
      const text = el('textarea'); text.rows = 2; text.maxLength = 500; text.required = true;
      text.placeholder = 'z. B. meißeliert, Maschinen gewaschen';
      const z1 = el('div', 'st-zeile'), z2 = el('div', 'st-zeile');
      [[z1, 'Beginn', von], [z1, 'Ende', bis], [z2, 'Pause von', pv], [z2, 'Pause bis', pb]].forEach(([z, t, feld]) => {
        const l = el('label', null, t); l.append(feld); z.append(l);
      });
      const lt = el('label', null, 'Was hast du an dem Tag gemacht?'); lt.append(text);
      const knoepfe = el('div', 'st-knoepfe klein');
      const ok = el('button', 'st-knopf start', 'Nachtrag senden'); ok.type = 'submit';
      const zurueck = el('button', 'st-knopf leise', 'Abbrechen'); zurueck.type = 'button';
      knoepfe.append(zurueck, ok);
      const meldung = el('div');
      f.append(el('p', 'klein', 'Pause leer lassen, wenn keine war. Der Nachtrag gilt, sobald Christian ihn freigibt.'), z1, z2, lt, knoepfe, meldung);
      zurueck.addEventListener('click', () => { arbeit = null; holen(); });
      f.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        meldung.replaceChildren();
        const zeit = (u) => new Date(tag + 'T' + u).toISOString();
        const folge = [['start', von.value]];
        if (pv.value || pb.value) {
          if (!pv.value || !pb.value) { meldung.replaceChildren(el('div', 'st-hinweis fehler', 'Bitte bei der Pause von und bis ausfüllen.')); return; }
          folge.push(['pause', pv.value], ['weiter', pb.value]);
        }
        folge.push(['stopp', bis.value]);
        if (folge.some((x, i) => i && x[1] <= folge[i - 1][1])) {
          meldung.replaceChildren(el('div', 'st-hinweis fehler', 'Die Uhrzeiten passen nicht zusammen (Beginn vor Pause vor Ende).'));
          return;
        }
        ok.disabled = true;
        const t = await sb.rpc('taetigkeit_speichern', { p_tag: tag, p_text: text.value });
        if (t.error) { ok.disabled = false; meldung.replaceChildren(fehlerKasten('Nicht gespeichert', t.error)); return; }
        for (const [art, u] of folge) {
          const { error } = await sb.rpc('stempel_nachtragen', { p_art: art, p_zeit: zeit(u), p_grund: 'Stempeln vergessen', p_user: null });
          if (error) { ok.disabled = false; meldung.replaceChildren(fehlerKasten('Nicht gespeichert', error)); return; }
        }
        arbeit = null;
        await holen();
        weiterNachFrage();
      });
      return { tag, f };
    }

    // Urlaub, Frei oder Krank für offene Tage; danach weiter mit dem Start
    async function setzen(tage, art, knopf) {
      knopf.disabled = true;
      fragMeldung.replaceChildren();
      for (const t of tage) {
        const { error } = await sb.rpc('abwesenheit_selbst', { p_von: t, p_bis: t, p_art: art });
        if (error) { knopf.disabled = false; fragMeldung.replaceChildren(fehlerKasten('Nicht gespeichert', error)); return; }
      }
      if (arbeit && tage.includes(arbeit.tag)) arbeit = null;
      await holen();
      weiterNachFrage();
    }
    function weiterNachFrage() {
      if (fragen && !offen.length) { fragen = false; druecken('start'); }
    }

    // Vorab eintragen (z. B. Urlaub nächste Woche) oder eigene Einträge streichen; einmal gebaut
    function vorabFormular() {
      const d = el('details', 'st-karte st-formular');
      d.append(el('summary', null, 'Urlaub oder frei eintragen'));
      const f = el('form', 'st');
      const z = el('div', 'st-zeile');
      const von = el('input'); von.type = 'date'; von.required = true;
      const bis = el('input'); bis.type = 'date';
      const art = el('select');
      [['urlaub', 'Urlaub'], ['frei', 'Frei (Stunden abbauen)'], ['krank', 'Krank'], ['', 'Eintrag streichen']].forEach(([w, t]) => {
        const o = el('option', null, t); o.value = w; art.append(o);
      });
      [['Von', von], ['Bis (leer = nur ein Tag)', bis]].forEach(([t, feld]) => { const l = el('label', null, t); l.append(feld); z.append(l); });
      const la = el('label', null, 'Was'); la.append(art);
      const knopf = el('button', null, 'Eintragen'); knopf.type = 'submit';
      const meldung = el('div');
      const geplant = el('div', 'st');
      f.append(el('p', 'klein', 'Wochenenden, Feiertage und Tage mit Stempel werden übersprungen. Was Christian eingetragen hat, kann nur er ändern.'),
        z, la, knopf, meldung);
      d.append(f, geplant);
      f.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        knopf.disabled = true;
        meldung.replaceChildren();
        const { data, error } = await sb.rpc('abwesenheit_selbst', { p_von: von.value, p_bis: bis.value || von.value, p_art: art.value || null });
        knopf.disabled = false;
        if (error) { meldung.replaceChildren(fehlerKasten('Nicht eingetragen', error)); return; }
        meldung.replaceChildren(el('div', 'st-hinweis' + (data ? ' ok' : ''), data ? (data === 1 ? '1 Tag' : data + ' Tage') + (art.value ? ' eingetragen.' : ' gestrichen.')
          : 'Nichts geändert (Wochenende, Feiertag, schon so eingetragen, gestempelt oder von Christian eingetragen).'));
        von.value = ''; bis.value = ''; von.blur(); bis.blur();
        holen();
      });
      return { d, geplant };
    }

    // Einmal gebaut, damit der Text das minütliche Neuladen übersteht
    function stoppFormular() {
      const f = el('form', 'st st-formular');
      const text = el('textarea'); text.rows = 3; text.maxLength = 500; text.required = true;
      text.placeholder = 'z. B. meißeliert, Maschinen gewaschen, Feldarbeiten';
      const l = el('label', null, 'Was hast du heute gemacht?'); l.append(text);
      const knoepfe = el('div', 'st-knoepfe klein');
      const ok = el('button', 'st-knopf stopp', 'Speichern und Stopp'); ok.type = 'submit';
      const zurueck = el('button', 'st-knopf leise', 'Abbrechen'); zurueck.type = 'button';
      knoepfe.append(zurueck, ok);
      const meldung = el('div');
      f.append(l, knoepfe, meldung);
      zurueck.addEventListener('click', () => { stoppFragen = false; meldung.replaceChildren(); holen(); });
      f.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        ok.disabled = true;
        meldung.replaceChildren();
        const t = await sb.rpc('taetigkeit_speichern', { p_tag: schichtTag || tagVon(new Date()), p_text: text.value });
        if (t.error) { ok.disabled = false; meldung.replaceChildren(fehlerKasten('Nicht gespeichert', t.error)); return; }
        const { error } = await sb.rpc('stempeln', { p_art: 'stopp' });
        ok.disabled = false;
        if (error) { meldung.replaceChildren(fehlerKasten('Stopp hat nicht geklappt', error)); return; }
        stoppFragen = false;
        text.value = '';
        holen();
      });
      return { f, text };
    }

    async function holen() {
      if (laeuft) return;
      laeuft = true;
      try {
        const ab = new Date(); ab.setDate(1); ab.setHours(0, 0, 0, 0); ab.setDate(ab.getDate() - 3);
        uid = uid || (await sb.auth.getUser()).data.user.id;
        const [pe, ks] = await Promise.all([
          sb.from('personen').select('user_id, name, festangestellt, urlaub_ab, urlaub_tage_jahr, soll_std_monat, ueberstundenkonto').eq('user_id', uid).maybeSingle(),
          sb.from('konto_start').select('user_id, stichtag, urlaub_rest, ueberstunden').eq('user_id', uid).maybeSingle()
        ]);
        if (pe.error || ks.error) throw pe.error || ks.error;
        person = pe.data && pe.data.festangestellt ? pe.data : null;
        start = ks.data || null;
        // Für das Konto alle Stempel seit dem ersten gezählten Tag
        const kab = person ? startTag(person, start) : null;
        const sab = kab && new Date(kab + 'T00:00:00') < ab ? new Date(kab + 'T00:00:00') : new Date(ab);
        sab.setDate(sab.getDate() - 1);
        const [s, t, a] = await Promise.all([
          sb.from('stempel').select('*').eq('user_id', uid).gte('zeit', sab.toISOString()).order('zeit'),
          sb.from('taetigkeiten').select('id, user_id, tag, text').eq('user_id', uid).gte('tag', tagVon(ab)).order('id'),
          person ? sb.from('abwesenheiten').select('id, user_id, tag, art, automatisch, grund, angelegt_von').eq('user_id', uid).is('storniert_am', null).order('tag')
            : Promise.resolve({ data: [], error: null })
        ]);
        if (s.error || t.error || a.error) throw s.error || t.error || a.error;
        taetigkeiten = taetigkeitenNach(t.data || []);
        abwesend = a.data || [];
        zeichnen(s.data || []);
      } catch (e) {
        oben.replaceChildren(fehlerKasten('Zeiten konnten nicht geladen werden', e));
      } finally { laeuft = false; }
    }

    async function druecken(art, knopf) {
      if (gesperrt) return;
      // Start: erst fragen, was an offenen Tagen war (gearbeitet, frei, Urlaub, krank)
      if (art === 'start' && offen.length && !spaeter) {
        fragen = true;
        await holen();
        window.scrollTo(0, 0);
        return;
      }
      spaeter = false;
      // Pause gerade erst begonnen: nachfragen, ob sie wirklich schon zu Ende ist
      if (art === 'weiter' && pauseSeit && Date.now() - new Date(pauseSeit).getTime() < 60000 &&
          !confirm('Die Pause läuft erst seit wenigen Sekunden. Pause wirklich schon beenden?')) return;
      // Stopp: erst fragen, was gemacht wurde (außer es steht schon da)
      if (art === 'stopp' && !taetigkeiten[uid + '|' + schichtTag]) {
        stoppFragen = true;
        await holen();
        stopp.text.focus();
        return;
      }
      gesperrt = true;
      if (knopf) knopf.disabled = true;
      const { error } = await sb.rpc('stempeln', { p_art: art });
      if (error) { oben.append(fehlerKasten('Hat nicht geklappt', error)); if (knopf) knopf.disabled = false; gesperrt = false; return; }
      await holen();
      setTimeout(() => {
        gesperrt = false;
        oben.querySelectorAll('.st-knopf').forEach((k) => { k.disabled = false; });
      }, 1500);
    }

    function zeichnen(stempel) {
      const z = zustand(stempel);
      const tage = auswerten(stempel);
      const heute = tage.find((t) => t.tag === tagVon(new Date()));
      const starts = stempel.filter((x) => x.art === 'start' && x.status !== 'abgelehnt');
      schichtTag = z.art !== 'aus' && starts.length ? tagVon(starts[starts.length - 1].zeit) : null;
      if (z.art === 'aus') stoppFragen = false;
      pauseSeit = z.art === 'pause' ? z.seit : null;
      const kt = person ? konto(person, start, stempel, abwesend) : null;
      const frueh = selbstAb();
      offen = kt ? kt.offen.filter((t) => t >= frueh) : [];
      if (z.art !== 'aus') fragen = false;

      // fragen bleibt nach dem letzten geklärten Tag stehen, bis weiterNachFrage() einstempelt
      if (fragen && offen.length) {
        oben.replaceChildren(frageKarte(kt));
        zeichnenListe(stempel, tage, kt);
        return;
      }

      const karte = el('div', 'st-karte st-status ' + z.art);
      karte.append(el('div', 'gross',
        z.art === 'arbeitet' ? 'Arbeitet seit ' + uhr(z.seit) : z.art === 'pause' ? 'Pause läuft seit ' + uhr(z.seit) : 'Nicht eingestempelt'));
      if (z.art === 'pause') karte.append(el('div', 'klein', 'Wenn du wieder anfängst: „Pause beenden“ drücken.'));
      karte.append(el('div', 'klein', 'Heute gearbeitet: ' + stunden(heute ? heute.arbeitMs : 0)));
      if (stoppFragen) {
        karte.append(stopp.f);
      } else {
        const knoepfe = el('div', 'st-knoepfe');
        const plan = z.art === 'aus' ? [['start', 'Start']] : z.art === 'arbeitet' ? [['pause', 'Pause'], ['stopp', 'Stopp']] : [['weiter', 'Pause beenden'], ['stopp', 'Stopp']];
        plan.forEach(([art, text]) => {
          const k = el('button', 'st-knopf ' + art, text);
          k.disabled = gesperrt;
          k.addEventListener('click', () => druecken(art, k));
          knoepfe.append(k);
        });
        karte.append(knoepfe);
        const schon = schichtTag && taetigkeiten[uid + '|' + schichtTag];
        if (schon) karte.append(el('div', 'klein', 'Heute gemacht: ' + schon));
      }
      const teile = [karte];
      if (z.art !== 'aus' && tagVon(z.seit) !== tagVon(new Date())) {
        teile.push(el('div', 'st-hinweis', 'Du bist seit ' + wannText(z.seit) + ' eingestempelt. Stopp vergessen? Dann unten den Stopp nachtragen.'));
      }
      oben.replaceChildren(...teile);
      zeichnenListe(stempel, tage, kt);
    }

    // Nachfrage vor dem Start: für jeden offenen Tag gearbeitet / frei / Urlaub / krank
    function frageKarte(kt) {
      const k = el('div', 'st-karte st-frage');
      k.append(el('h3', null, offen.length === 1 ? 'Bevor du anfängst: Für diesen Tag ist nichts eingetragen.' : 'Bevor du anfängst: Für diese Tage ist nichts eingetragen.'));
      k.append(el('p', 'klein', kontoText(kt)));
      if (offen.length > 1) {
        const z = el('div', 'st-fragzeile alle');
        z.append(el('span', 'datum', 'Alle ' + offen.length + ' Tage:'));
        [['frei', 'Frei'], ['urlaub', 'Urlaub'], ['krank', 'Krank']].forEach(([w, t]) => {
          const b = el('button', 'st-wahl ' + w, t); b.type = 'button';
          b.addEventListener('click', () => setzen(offen.slice(), w, b));
          z.append(b);
        });
        k.append(z);
      }
      offen.forEach((tag) => {
        const z = el('div', 'st-fragzeile');
        z.append(el('span', 'datum', datumKurz(tag)));
        const g = el('button', 'st-wahl arbeit', 'Gearbeitet'); g.type = 'button';
        g.addEventListener('click', () => { arbeit = arbeitFormular(tag); holen(); });
        z.append(g);
        [['frei', 'Frei'], ['urlaub', 'Urlaub'], ['krank', 'Krank']].forEach(([w, t]) => {
          const b = el('button', 'st-wahl ' + w, t); b.type = 'button';
          b.addEventListener('click', () => setzen([tag], w, b));
          z.append(b);
        });
        k.append(z);
        if (arbeit && arbeit.tag === tag) k.append(arbeit.f);
      });
      k.append(el('p', 'klein', 'Frei = Stunden vom Stundenkonto abbauen, Urlaub bleibt. Urlaub = ein Urlaubstag, das Stundenkonto bleibt gleich.'));
      const spaet = el('button', 'st-knopf leise', 'Später – jetzt erst einstempeln'); spaet.type = 'button';
      spaet.addEventListener('click', () => { spaeter = true; fragen = false; arbeit = null; druecken('start', spaet); });
      k.append(fragMeldung, spaet);
      return k;
    }

    function kontoText(kt) {
      const t = [];
      if (kt && kt.ueberstunden !== null) t.push('Stundenkonto: ' + vorzeichen(kt.ueberstunden) + ' Std.');
      if (kt && kt.urlaubRest !== null) t.push('Resturlaub: ' + zahlText(kt.urlaubRest) + ' Tage');
      return t.join(' · ');
    }

    // Unten: mein Konto, Urlaub/Frei vorab, Zeiten und Abwesenheiten des Monats
    function zeichnenListe(stempel, tage, kt) {
      const teile = [];
      if (kt) {
        const kk = el('div', 'st-karte');
        kk.append(el('h3', null, 'Mein Konto'));
        if (kt.ueberstunden !== null) kk.append(el('div', 'st-summe', 'Stundenkonto bis gestern: ' + vorzeichen(kt.ueberstunden) + ' Std.'));
        if (kt.urlaubRest !== null) kk.append(el('div', 'st-summe', 'Resturlaub: ' + zahlText(kt.urlaubRest) + ' Tage'));
        if (kt.urlaubRest !== null) kk.append(el('p', 'klein', 'Schon eingetragener Urlaub (auch später im Jahr) ist abgezogen.'));
        if (offen.length) kk.append(el('div', 'st-hinweis', 'Noch offen: ' + offen.map(datumKurz).join(', ') + '. Beim nächsten Start fragt die App nach.'));
        teile.push(kk);
        // eigene Einträge ab heute, mit Streichen (außer vom Chef)
        const heute = tagVon(new Date());
        const kommend = abwesend.filter((x) => x.tag >= heute);
        const g = [];
        if (kommend.length) g.push(el('h3', null, 'Eingetragen ab heute'));
        kommend.forEach((x) => {
          const z = el('div', 'st-tag abwesend');
          z.append(el('span', 'datum', datumKurz(x.tag)), el('span', 'zeit', ABWESEND[x.art]));
          if (x.automatisch || x.angelegt_von === uid) {
            const b = el('button', 'st-wahl', 'Streichen'); b.type = 'button';
            b.addEventListener('click', async () => {
              b.disabled = true;
              const { error } = await sb.rpc('abwesenheit_selbst', { p_von: x.tag, p_bis: x.tag, p_art: null });
              if (error) { b.disabled = false; z.append(fehlerKasten('Nicht gestrichen', error)); return; }
              holen();
            });
            z.append(b);
          } else {
            z.append(el('span', 'klein', 'von Christian'));
          }
          g.push(z);
        });
        vorab.geplant.replaceChildren(...g);
        teile.push(vorab.d);
      }

      const monat = tagVon(new Date()).slice(0, 7);
      const imMonat = tage.filter((t) => t.tag.startsWith(monat));
      const k = el('div', 'st-karte');
      k.append(el('h3', null, 'Meine Zeiten im ' + new Date().toLocaleDateString('de-DE', { month: 'long' })));
      k.append(el('div', 'st-summe', 'Zusammen: ' + stunden(imMonat.reduce((s, t) => s + t.arbeitMs, 0))));
      const weg = abwesend.filter((x) => x.tag.startsWith(monat) && x.tag <= tagVon(new Date()));
      imMonat.map((t) => ({ tag: t.tag, t })).concat(weg.map((x) => ({ tag: x.tag, x })))
        .sort((a, b) => (a.tag < b.tag ? 1 : -1)).forEach(({ t, x }) => {
          if (t) { k.append(tagesZeile(t, taetigkeiten[uid + '|' + t.tag])); return; }
          const z = el('div', 'st-tag abwesend');
          z.append(el('span', 'datum', datumKurz(x.tag)), el('span', 'zeit', ABWESEND[x.art]));
          k.append(z);
        });
      // nur abgelehnte Nachträge; vom Chef gestrichene Fehl-Tipper sind keine Nachricht wert
      const abgelehnt = stempel.filter((s) => s.status === 'abgelehnt' && s.nachtrag);
      abgelehnt.forEach((s) => k.append(el('div', 'st-hinweis', 'Nachtrag abgelehnt: ' + ARTEN[s.art] + ' ' + wannText(s.zeit))));
      if (!imMonat.length && !weg.length) k.append(el('p', 'klein', 'Noch keine Zeiten in diesem Monat.'));
      teile.push(k);
      liste.replaceChildren(...teile);
    }

    regelmaessig(box, holen);
  }

  // ---------- Vorschau ----------
  // Für den Chef: die Mitarbeiter-Ansicht zum Ausprobieren. Alles bleibt im Speicher des Geräts
  // und ist beim Verlassen weg; die Regeln sind dieselben wie in der Datenbank (012_stopp_mit_taetigkeit).
  function vorschauDb() {
    const uid = 'vorschau';
    const stempel = [], taetigkeiten = [], abwesend = [];
    let id = 0;
    function stempelDazu(art, zeit, extra) { stempel.push(Object.assign({ id: ++id, user_id: uid, art, zeit, status: 'gueltig', nachtrag: false }, extra)); }
    // Die letzten vier Werktage: die zwei älteren gearbeitet, die zwei jüngsten offen (dann fragt Start nach)
    const werktage = [];
    for (let d = tagPlus(tagVon(new Date()), -1); werktage.length < 4; d = tagPlus(d, -1)) if (wochentag(d) <= 5 && !feiertag(d)) werktage.push(d);
    [[werktage[3], '06:30', '17:15', 'Meißeliert'], [werktage[2], '07:00', '16:45', 'Maschinen gewaschen']].forEach(([d, von, bis, text]) => {
      stempelDazu('start', new Date(d + 'T' + von).toISOString());
      stempelDazu('stopp', new Date(d + 'T' + bis).toISOString());
      taetigkeiten.push({ id: ++id, user_id: uid, tag: d, text });
    });
    const person = { user_id: uid, name: 'Vorschau', festangestellt: true, urlaub_ab: null, urlaub_tage_jahr: 30, soll_std_monat: 173, ueberstundenkonto: true };
    const start = { user_id: uid, stichtag: tagPlus(werktage[3], -1), urlaub_rest: 18, ueberstunden: 12.5 };
    const fehler = (message) => ({ error: { message } });
    const abfrage = (zeilen) => {
      const ergebnis = () => Promise.resolve({ data: zeilen.slice(), error: null });
      const o = { select: () => o, eq: () => o, neq: () => o, is: () => o, gte: () => o, lt: () => o, lte: () => o, order: () => o,
        maybeSingle: () => ({ then: (f) => Promise.resolve({ data: zeilen[0] || null, error: null }).then(f) }),
        then: (f) => ergebnis().then(f) };
      return o;
    };
    const tabellen = () => ({ taetigkeiten, stempel, personen: [person], konto_start: [start],
      abwesenheiten: abwesend.filter((x) => !x.storniert) });
    return {
      auth: { getUser: async () => ({ data: { user: { id: uid } } }) },
      from: (t) => abfrage(tabellen()[t] || []),
      rpc: async (name, a) => {
        if (name === 'abwesenheit_selbst') {
          if (a.p_von < tagPlus(start.stichtag, 1) || a.p_von < selbstAb()) return fehler('Tage vor dem ' + datumKurz(selbstAb()) + ' kann nur Christian ändern');
          let n = 0;
          for (let d = a.p_von; d <= a.p_bis; d = tagPlus(d, 1)) {
            if (wochentag(d) > 5 || feiertag(d)) continue;
            const alt = abwesend.find((x) => x.tag === d && !x.storniert);
            if (a.p_art === null) { if (alt) { alt.storniert = true; n++; } continue; }
            if ((alt && alt.art === a.p_art) || stempel.some((s) => s.status !== 'abgelehnt' && tagVon(s.zeit) === d)) continue;
            if (alt) alt.storniert = true;
            abwesend.push({ id: ++id, user_id: uid, tag: d, art: a.p_art, automatisch: false, grund: 'vom Mitarbeiter eingetragen', angelegt_von: uid });
            n++;
          }
          return { data: n, error: null };
        }
        if (name === 'taetigkeit_speichern') {
          if (!String(a.p_text || '').trim()) return fehler('Bitte etwas eintragen');
          taetigkeiten.push({ id: ++id, user_id: uid, tag: a.p_tag, text: a.p_text.trim() });
          return { error: null };
        }
        if (name === 'stempeln') {
          const z = zustand(stempel).art;
          const ok = (z === 'aus' && a.p_art === 'start') || (z === 'arbeitet' && ['pause', 'stopp'].includes(a.p_art)) ||
            (z === 'pause' && ['weiter', 'stopp'].includes(a.p_art));
          if (!ok) return fehler('Das passt gerade nicht. Bitte die Seite neu laden.');
          if (a.p_art === 'stopp') {
            const starts = stempel.filter((x) => x.art === 'start' && x.status !== 'abgelehnt');
            const t = tagVon(starts[starts.length - 1].zeit);
            if (!taetigkeiten.some((x) => x.tag === t)) return fehler('Bitte zuerst eintragen, was du heute gemacht hast');
          }
          stempelDazu(a.p_art, new Date().toISOString());
          return { error: null };
        }
        if (name === 'stempel_nachtragen') {
          if (new Date(a.p_zeit) > new Date()) return fehler('Die Zeit liegt in der Zukunft');
          stempelDazu(a.p_art, a.p_zeit, { nachtrag: true, grund: a.p_grund, status: 'offen' });
          return { error: null };
        }
        return fehler('In der Vorschau nicht möglich');
      }
    };
  }

  function zeigeVorschau(ziel, zurueck) {
    const kopf = el('div', 'st-hinweis st-vorschau');
    kopf.append(el('div', null, 'Vorschau: So sieht ein Mitarbeiter die App. Probier alles aus – nichts wird gespeichert.'));
    const ende = el('button', 'st-knopf leise', 'Vorschau beenden');
    ende.addEventListener('click', () => { box.remove(); zurueck(); });
    kopf.append(ende);
    const inhalt = el('div');
    const box = el('div', 'st');
    box.append(kopf, inhalt);
    ziel.replaceChildren(box);
    zeigeMitarbeiter(inhalt, vorschauDb());
    window.scrollTo(0, 0);
  }

  // ---------- Chef ----------
  function zeigeChef(ziel) {
    const box = el('div', 'st');
    const jetzt = new Date();
    let jahr = jetzt.getFullYear(), monat = jetzt.getMonth();
    let laeuft = false;
    ziel.replaceChildren(box);
    // Formulare nur einmal bauen, damit Eingaben das minütliche Neuladen überstehen
    const kontoKarte = kontoFormular(() => holen());
    let nachtragKarte = null, nachtragFuer = '';
    const offen = new Set(); // aufgeklappte Personen im Monat
    const urlaubOffen = new Set(); // aufgeklappte Personen in der Urlaubsübersicht
    let urlaubKarte = null, urlaubStand = '';
    const vorschauKnopf = el('button', 'st-knopf leise', 'Mitarbeiter-Ansicht ausprobieren');
    vorschauKnopf.addEventListener('click', () => zeigeVorschau(ziel, () => zeigeChef(ziel)));

    async function holen() {
      if (laeuft) return;
      laeuft = true;
      try {
        const von = new Date(jahr, monat, 1); von.setDate(von.getDate() - 2);
        const bis = new Date(jahr, monat + 1, 1); bis.setDate(bis.getDate() + 1);
        const kurz = new Date(); kurz.setDate(kurz.getDate() - 14);
        const [p, m, k, o, t, a, s] = await Promise.all([
          window.sb.from('personen').select('user_id, name, stempelt, festangestellt, urlaub_ab, urlaub_tage_jahr, soll_std_monat, ueberstundenkonto').eq('stempelt', true).order('name'),
          window.sb.from('stempel').select('*').gte('zeit', von.toISOString()).lt('zeit', bis.toISOString()).order('zeit'),
          window.sb.from('stempel').select('*').gte('zeit', kurz.toISOString()).order('zeit'),
          window.sb.from('stempel').select('*').eq('status', 'offen').order('zeit'),
          window.sb.from('taetigkeiten').select('id, user_id, tag, text').gte('tag', tagVon(von)).lt('tag', tagVon(bis)).order('id'),
          window.sb.from('abwesenheiten').select('id, user_id, tag, art, automatisch, grund').is('storniert_am', null)
            .gte('tag', jahr + '-01-01').lte('tag', jahr + '-12-31').order('tag'),
          window.sb.from('konto_start').select('user_id, stichtag, urlaub_rest, ueberstunden')
        ]);
        const fehler = p.error || m.error || k.error || o.error || t.error || a.error || s.error;
        if (fehler) throw fehler;
        // Für Resturlaub und Überstunden: alle Stempel und Abwesenheiten seit dem frühesten Startstand
        const fest = (p.data || []).filter((x) => x.festangestellt);
        const starts = fest.map((x) => startTag(x, (s.data || []).find((y) => y.user_id === x.user_id))).filter(Boolean).sort();
        let konten = {};
        if (starts.length) {
          const ab = new Date(starts[0] + 'T00:00:00'); ab.setDate(ab.getDate() - 1);
          const [ks, ka] = await Promise.all([
            window.sb.from('stempel').select('*').neq('status', 'abgelehnt').gte('zeit', ab.toISOString()).order('zeit'),
            window.sb.from('abwesenheiten').select('user_id, tag, art').is('storniert_am', null).gte('tag', starts[0]).order('tag')
          ]);
          if (ks.error || ka.error) throw ks.error || ka.error;
          fest.forEach((x) => {
            konten[x.user_id] = konto(x, (s.data || []).find((y) => y.user_id === x.user_id),
              ks.data.filter((y) => y.user_id === x.user_id), ka.data.filter((y) => y.user_id === x.user_id));
          });
        }
        if (!box.isConnected) return;
        zeichnen(p.data || [], m.data || [], k.data || [], o.data || [], taetigkeitenNach(t.data || []), a.data || [], konten);
      } catch (e) {
        box.replaceChildren(fehlerKasten('Zeiten konnten nicht geladen werden', e));
      } finally { laeuft = false; }
    }

    function zeichnen(personen, imMonat, kuerzlich, offene, taetigkeiten, abwesend, konten) {
      const name = {};
      personen.forEach((p) => { name[p.user_id] = p.name; });
      const teile = [];

      teile.push(vorschauKnopf);
      if (!personen.length) {
        teile.push(el('div', 'st-hinweis', 'Noch keine Mitarbeiter angelegt. Unten über „Konto für Mitarbeiter anlegen“ hinzufügen.'));
      }

      // Nachträge zur Freigabe
      if (offene.length) {
        const k = el('div', 'st-karte');
        k.append(el('h3', null, 'Nachträge zur Freigabe (' + offene.length + ')'));
        offene.forEach((s) => {
          const z = el('div', 'st-nachtrag');
          z.append(el('div', 'was', (name[s.user_id] || '?') + ': ' + ARTEN[s.art] + ' ' + wannText(s.zeit)));
          z.append(el('div', 'klein', 'Grund: ' + (s.grund || '–') + ' · eingetragen ' + wannText(s.angelegt_am)));
          const knoepfe = el('div', 'st-knoepfe klein');
          [['Freigeben', true], ['Ablehnen', false]].forEach(([t, ok]) => {
            const b = el('button', 'st-knopf ' + (ok ? 'start' : 'stopp'), t);
            b.addEventListener('click', async () => {
              b.disabled = true;
              const { error } = await window.sb.rpc('nachtrag_entscheiden', { p_id: s.id, p_ok: ok });
              if (error) { z.append(fehlerKasten('Hat nicht geklappt', error)); b.disabled = false; return; }
              holen();
            });
            knoepfe.append(b);
          });
          z.append(knoepfe);
          k.append(z);
        });
        teile.push(k);
      }

      // Wer arbeitet gerade (nur gültige Stempel)
      if (personen.length) {
        const k = el('div', 'st-karte');
        k.append(el('h3', null, 'Jetzt'));
        personen.forEach((p) => {
          const eigene = kuerzlich.filter((s) => s.user_id === p.user_id && s.status === 'gueltig');
          const z = zustand(eigene);
          const heute = auswerten(eigene).find((t) => t.tag === tagVon(new Date()));
          const alt = z.art !== 'aus' && tagVon(z.seit) !== tagVon(new Date());
          const zeile = el('div', 'st-person');
          // Heute: Beginn der Schicht und Pause zusammen, nicht nur der letzte Knopfdruck
          let text = z.art === 'arbeitet' ? 'arbeitet seit ' + wannText(z.seit) : z.art === 'pause' ? 'Pause seit ' + wannText(z.seit) : 'nicht da';
          if (heute && !alt) {
            const pause = heute.pauseMs ? ' · Pause ' + stunden(heute.pauseMs).replace(' Std.', '') : '';
            // kurz, damit es am Handy in eine Zeile passt
            if (z.art === 'arbeitet') text = 'Start ' + uhr(heute.beginn) + pause;
            else if (z.art === 'pause') text = 'Start ' + uhr(heute.beginn) + ' · Pause ' + uhr(z.seit);
            else text = uhr(heute.beginn) + '–' + (heute.ende ? uhr(heute.ende) : '?') + pause;
          }
          zeile.append(el('span', 'punkt ' + (alt ? 'alt' : z.art)), el('span', 'name', p.name),
            el('span', 'zustand', text + (alt ? ' – Stopp vergessen?' : '')),
            el('span', 'std', heute ? stunden(heute.arbeitMs).replace(' Std.', ' h') : ''));
          k.append(zeile);
        });
        teile.push(k);
      }

      // Monat
      const mk = el('div', 'st-karte');
      const kopf = el('div', 'st-monatkopf');
      const zur = el('button', 'st-pfeil', '‹');
      const vor = el('button', 'st-pfeil', '›');
      zur.addEventListener('click', () => { monat--; if (monat < 0) { monat = 11; jahr--; } holen(); });
      vor.addEventListener('click', () => { monat++; if (monat > 11) { monat = 0; jahr++; } holen(); });
      kopf.append(zur, el('h3', null, monatName(jahr, monat)), vor);
      mk.append(kopf);
      const praefix = jahr + '-' + String(monat + 1).padStart(2, '0');
      const export_ = [];
      personen.forEach((p) => {
        const tage = auswerten(imMonat.filter((s) => s.user_id === p.user_id && s.status === 'gueltig'))
          .filter((t) => t.tag.startsWith(praefix));
        const summe = tage.reduce((s, t) => s + t.arbeitMs, 0);
        const weg = abwesend.filter((x) => x.user_id === p.user_id && x.tag.startsWith(praefix));
        // Werktage ohne Stempel und ohne Eintrag (022): Mitarbeiter wird beim nächsten Start gefragt
        const kt = konten[p.user_id];
        const offenIm = kt ? kt.offen.filter((t) => t.startsWith(praefix)) : [];
        const d = el('details', 'st-monat');
        d.open = offen.has(p.user_id);
        d.addEventListener('toggle', () => { if (d.open) offen.add(p.user_id); else offen.delete(p.user_id); });
        const sum = el('summary');
        const zeile = el('div', 'zeile');
        zeile.append(el('span', 'name', p.name), el('span', 'klein', tage.length + (tage.length === 1 ? ' Tag' : ' Tage')), el('span', 'std', stunden(summe)));
        if (tage.some((t) => t.stoppFehlt)) zeile.append(el('span', 'marke', 'Stopp fehlt'));
        if (offenIm.length) zeile.append(el('span', 'marke', offenIm.length + ' offen'));
        sum.append(zeile);
        d.append(sum);
        // Arbeitstage, Abwesenheiten und offene Tage nach Datum
        tage.map((t) => ({ tag: t.tag, t })).concat(weg.map((x) => ({ tag: x.tag, x })), offenIm.map((o) => ({ tag: o, o })))
          .sort((a, b) => (a.tag < b.tag ? -1 : 1)).forEach(({ t, x, o }) => {
            if (o) {
              const z = el('div', 'st-tag abwesend offen');
              z.append(el('span', 'datum', datumKurz(o)), el('span', 'zeit', 'offen – nichts eingetragen'));
              d.append(z);
              export_.push([p.name, o.split('-').reverse().join('.'), '', '', '', '', '', 'offen (nichts eingetragen)']);
              return;
            }
            if (x) {
              d.append(abwesendZeile(x));
              export_.push([p.name, x.tag.split('-').reverse().join('.'), '', '', '', '', '', ABWESEND[x.art] + (x.automatisch ? ' (automatisch)' : '')]);
              return;
            }
            const taetigkeit = taetigkeiten[p.user_id + '|' + t.tag] || '';
            d.append(tagesZeile(t, taetigkeit));
            export_.push([p.name, t.tag.split('-').reverse().join('.'), uhr(t.beginn), t.ende ? uhr(t.ende) : '',
              dezimal(t.pauseMs), dezimal(t.arbeitMs), taetigkeit, [t.stoppFehlt ? 'Stopp fehlt' : '', t.nachtrag ? 'Nachtrag' : ''].filter(Boolean).join(', ')]);
          });
        if (!tage.length && !weg.length) d.append(el('p', 'klein', 'Keine Zeiten in diesem Monat.'));
        mk.append(d);
      });
      if (export_.length) {
        const dl = el('button', 'st-knopf leise', 'Liste fürs Lohnbüro herunterladen');
        dl.addEventListener('click', () => herunterladen(export_, 'Stunden ' + praefix + '.csv'));
        mk.append(dl);
      }
      teile.push(mk);

      if (personen.length) {
        // nur neu bauen, wenn sich etwas geändert hat und niemand gerade tippt
        const stand = JSON.stringify([jahr, personen, abwesend, konten]);
        if (!urlaubKarte || (stand !== urlaubStand && !urlaubKarte.contains(document.activeElement))) {
          urlaubStand = stand;
          urlaubKarte = urlaubUebersicht(personen, abwesend, konten);
        }
        teile.push(urlaubKarte);
      }

      const fuer = personen.map((p) => p.user_id + p.name).join();
      if (fuer !== nachtragFuer) { nachtragFuer = fuer; nachtragKarte = personen.length ? nachtragFormular(personen, () => holen()) : null; }
      if (nachtragKarte) teile.push(nachtragKarte);
      teile.push(kontoKarte);
      box.replaceChildren(...teile);
    }

    // Resturlaub und Überstunden je Festangestelltem (siehe konto()), dazu die Urlaubs-/Krank-/Frei-Tage des angezeigten Jahres.
    // Automatisch eingetragen wird nur bei Festangestellten (Wochentag ohne Stempel, siehe 019_urlaub.sql).
    function urlaubUebersicht(personen, abwesend, konten) {
      const k = el('div', 'st-karte st-formular');
      k.append(el('h3', null, 'Urlaub und Überstunden'));
      const fest = personen.filter((p) => p.festangestellt);
      if (!fest.length) k.append(el('p', 'klein', 'Noch niemand ausgewählt. Unten ankreuzen, wer festangestellt ist.'));
      fest.forEach((p) => {
        const eigene = abwesend.filter((x) => x.user_id === p.user_id);
        const urlaub = eigene.filter((x) => x.art === 'urlaub').length;
        const krank = eigene.filter((x) => x.art === 'krank').length;
        const kt = konten[p.user_id];
        const d = el('details', 'st-monat');
        d.open = urlaubOffen.has(p.user_id);
        d.addEventListener('toggle', () => { if (d.open) urlaubOffen.add(p.user_id); else urlaubOffen.delete(p.user_id); });
        const sum = el('summary');
        const zeile = el('div', 'zeile');
        zeile.append(el('span', 'name', p.name),
          el('span', 'klein', kt && kt.urlaubRest !== null ? 'Urlaub ' + zahlText(kt.urlaubRest) : ''),
          el('span', 'std', kt && kt.ueberstunden !== null ? vorzeichen(kt.ueberstunden) + ' Std.' : ''));
        const mitKonto = p.ueberstundenkonto !== false;
        if (!p.urlaub_tage_jahr || (mitKonto && !p.soll_std_monat)) zeile.append(el('span', 'marke', 'Angaben fehlen'));
        sum.append(zeile);
        d.append(sum);

        // Stand
        if (kt) {
          const info = [];
          info.push(kt.start ? 'Startstand am ' + datumKurz(kt.start.stichtag) + ': Urlaub ' + zahlText(kt.start.urlaub_rest) + ' Tage' +
            (mitKonto ? ', Überstunden ' + vorzeichen(kt.start.ueberstunden) + ' Std.' : '') : 'Kein Startstand – gezählt ab ' + datumKurz(kt.ab) + ' mit 0.');
          if (!mitKonto) info.push('Festgehalt: kein Überstundenkonto, nur Stunden und Urlaub.');
          if (kt.urlaubRest !== null) info.push('Resturlaub: ' + zahlText(kt.urlaubRest) + ' Tage (eingetragene Urlaubstage abgezogen).');
          if (kt.ueberstunden !== null) {
            info.push('Überstunden bis gestern: ' + vorzeichen(kt.ueberstunden) + ' Std.');
            if (kt.monatSoll) info.push('Diesen Monat bis gestern: gearbeitet ' + zahlText(kt.monatIst) + ' Std. (mit Urlaub/Krank/Feiertag), Soll ' + zahlText(kt.monatSoll) + ' Std.');
          }
          if (kt.offen.length) info.push('Offen (nichts eingetragen, zählt als nicht gearbeitet): ' + kt.offen.map(datumKurz).join(', '));
          info.forEach((t) => d.append(el('p', 'klein', t)));
        }
        d.append(el('p', 'klein', jahr + ': ' + urlaub + (urlaub === 1 ? ' Tag' : ' Tage') + ' Urlaub' + (krank ? ', ' + krank + (krank === 1 ? ' Tag' : ' Tage') + ' krank' : '') + ' eingetragen'));

        // Urlaubstage pro Jahr und Sollstunden pro Monat
        const fa = el('form', 'st-zeile');
        const tage = el('input'); tage.type = 'number'; tage.min = '0'; tage.max = '60'; tage.step = '0.5'; tage.required = true;
        tage.value = p.urlaub_tage_jahr ?? ''; tage.placeholder = 'z. B. 24';
        const soll = el('input'); soll.type = 'number'; soll.min = '0'; soll.max = '300'; soll.step = '0.5'; soll.required = true;
        soll.value = p.soll_std_monat ?? ''; soll.placeholder = 'z. B. 173';
        const la = el('label', null, 'Urlaubstage pro Jahr'); la.append(tage);
        const ls = el('label', null, 'Std. pro Monat'); ls.append(soll);
        const ka = el('button', null, 'Speichern'); ka.type = 'submit';
        if (!mitKonto) soll.required = false;
        fa.append(la);
        if (mitKonto) fa.append(ls);
        fa.append(ka);
        fa.addEventListener('submit', async (ev) => {
          ev.preventDefault(); ka.disabled = true;
          const { error } = await window.sb.rpc('person_vertrag_setzen', { p_user: p.user_id, p_urlaub_tage_jahr: Number(tage.value),
            p_soll_std_monat: mitKonto ? Number(soll.value) : (p.soll_std_monat ?? null) });
          ka.disabled = false;
          if (error) { fa.append(fehlerKasten('Nicht gespeichert', error)); return; }
          tage.blur(); soll.blur(); holen();
        });
        d.append(fa);
        // Überstundenkonto an/aus (021), z. B. aus bei Festgehalt
        const lk = el('label', 'st-haken');
        const ck = el('input'); ck.type = 'checkbox'; ck.checked = mitKonto;
        ck.addEventListener('change', async () => {
          ck.disabled = true;
          const { error } = await window.sb.rpc('person_ueberstundenkonto_setzen', { p_user: p.user_id, p_an: ck.checked });
          ck.disabled = false;
          if (error) { ck.checked = !ck.checked; d.append(fehlerKasten('Nicht gespeichert', error)); return; }
          ck.blur(); holen();
        });
        lk.append(ck, el('span', null, 'Überstundenkonto führen'));
        d.append(lk);

        eigene.slice().reverse().forEach((x) => d.append(abwesendZeile(x, true)));
        if (!eigene.length) d.append(el('p', 'klein', 'Noch keine Tage eingetragen.'));

        // Tag von Hand eintragen
        const fn = el('form', 'st-zeile');
        const tag = el('input'); tag.type = 'date'; tag.required = true;
        const art = el('select');
        Object.entries(ABWESEND).forEach(([w, t]) => { const o = el('option', null, t); o.value = w; art.append(o); });
        const lt = el('label', null, 'Tag'); lt.append(tag);
        const lr = el('label', null, 'Art'); lr.append(art);
        const kn = el('button', null, 'Eintragen'); kn.type = 'submit';
        fn.append(lt, lr, kn);
        fn.addEventListener('submit', async (ev) => {
          ev.preventDefault(); kn.disabled = true;
          const { error } = await window.sb.rpc('abwesenheit_setzen', { p_user: p.user_id, p_tag: tag.value, p_art: art.value, p_grund: null });
          kn.disabled = false;
          if (error) { fn.append(fehlerKasten('Nicht eingetragen', error)); return; }
          tag.value = ''; tag.blur(); holen();
        });
        d.append(fn);
        k.append(d);
      });

      // Wer ist festangestellt (Urlaub, Konto)? Automatischer Urlaub nur ohne Überstundenkonto (022)
      const w = el('details', 'st-formular');
      w.append(el('summary', null, 'Wer ist festangestellt?'));
      w.append(el('p', 'klein', 'Angekreuzte haben Urlaub und tragen Urlaub, Frei und Krank selbst ein – ab dem Tag nach dem Ankreuzen. Mit Überstundenkonto bleibt ein Werktag ohne Stempel offen, bis der Mitarbeiter beim nächsten Start wählt (gearbeitet, frei, Urlaub, krank). Ohne Überstundenkonto (Festgehalt) trägt die App so einen Tag am nächsten Morgen als Urlaub ein. Minijobber nicht ankreuzen.'));
      personen.forEach((p) => {
        const l = el('label', 'st-haken');
        const c = el('input'); c.type = 'checkbox'; c.checked = !!p.festangestellt;
        c.addEventListener('change', async () => {
          c.disabled = true;
          const { error } = await window.sb.rpc('person_festangestellt_setzen', { p_user: p.user_id, p_an: c.checked });
          c.disabled = false;
          if (error) { c.checked = !c.checked; w.append(fehlerKasten('Nicht gespeichert', error)); return; }
          c.blur(); holen();
        });
        l.append(c, el('span', null, p.name + (p.festangestellt && p.urlaub_ab ? ' (ab ' + datumKurz(p.urlaub_ab) + ')' : '')));
        w.append(l);
      });
      k.append(w);
      return k;
    }

    // Eine Zeile Urlaub/Krank/Frei; mit aendern = Auswahl zum Ändern oder Streichen
    function abwesendZeile(x, aendern) {
      const z = el('div', 'st-tag abwesend');
      z.append(el('span', 'datum', datumKurz(x.tag)), el('span', 'zeit', ABWESEND[x.art] +
        (x.automatisch ? ' (automatisch)' : x.grund === 'vom Mitarbeiter eingetragen' ? ' (selbst eingetragen)' : '')));
      if (aendern) {
        const s = el('select');
        Object.entries(ABWESEND).concat([['', 'Streichen']]).forEach(([w, t]) => { const o = el('option', null, t); o.value = w; s.append(o); });
        s.value = x.art;
        s.addEventListener('change', async () => {
          s.disabled = true;
          const { error } = await window.sb.rpc('abwesenheit_setzen', { p_user: x.user_id, p_tag: x.tag, p_art: s.value || null, p_grund: null });
          s.disabled = false;
          if (error) { s.value = x.art; z.append(fehlerKasten('Nicht geändert', error)); return; }
          s.blur(); holen();
        });
        z.append(s);
      }
      return z;
    }

    regelmaessig(box, holen);
  }

  function zahlText(n) { return Number(n).toLocaleString('de-DE', { maximumFractionDigits: 1 }); }
  function vorzeichen(n) { const r = Math.round(n * 10) / 10; return (r > 0 ? '+' : '') + zahlText(r); }

  // Gesetzliche Feiertage in Bayern (gleich wie public.feiertag_bayern in 019_urlaub.sql)
  function feiertag(tag) {
    const [j, mo, t] = tag.split('-').map(Number);
    const a = j % 19, b = Math.floor(j / 100), c = j % 100, k = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - k - g + 15) % 30;
    const i = Math.floor(c / 4), l = (32 + 2 * e + 2 * i - h - c % 4) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const ostern = Date.UTC(j, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1);
    const abOstern = Math.round((Date.UTC(j, mo - 1, t) - ostern) / 86400000);
    const md = tag.slice(5);
    return ['01-01', '01-06', '05-01', '08-15', '10-03', '11-01', '12-25', '12-26'].includes(md) || [-2, 1, 39, 50, 60].includes(abOstern);
  }
  // „2026-10-27“ ± Tage, als Text; Wochentag 1 = Mo … 7 = So
  function tagPlus(tag, n) { const d = new Date(tag + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function wochentag(tag) { return new Date(tag + 'T12:00:00Z').getUTCDay() || 7; }

  // Erster gezählter Tag: Tag nach dem Startstand, sonst der Beginn des automatischen Urlaubs
  function startTag(p, start) { return start ? tagPlus(start.stichtag, 1) : p.urlaub_ab || null; }

  // Frühester Tag, den ein Mitarbeiter selbst ändern darf: Monatsanfang, bis zum 5. der Vormonat
  // (gleich wie public.abwesenheit_selbst_ab in 022_abwesenheit_selbst.sql)
  function selbstAb() {
    const heute = tagVon(new Date());
    const [j, m, t] = heute.split('-').map(Number);
    if (t > 5) return heute.slice(0, 8) + '01';
    return m === 1 ? (j - 1) + '-12-01' : j + '-' + String(m - 1).padStart(2, '0') + '-01';
  }

  // Werktage (Mo–Fr, kein Feiertag) von–bis ohne Stempel (gültig oder wartend) und ohne Urlaub/Krank/Frei = „offen“
  function offeneTage(von, bis, stempel, abwesend) {
    const belegt = new Set(stempel.filter((s) => s.status !== 'abgelehnt').map((s) => tagVon(s.zeit)));
    abwesend.forEach((x) => belegt.add(x.tag));
    const offen = [];
    for (let d = von; d <= bis; d = tagPlus(d, 1)) {
      if (wochentag(d) <= 5 && !feiertag(d) && !belegt.has(d)) offen.push(d);
    }
    return offen;
  }

  // Resturlaub und Überstundenkonto einer Person bis gestern (020_konten.sql)
  //   Tagessoll = Sollstunden pro Monat / Wochentage (Mo–Fr) des Monats
  //   Überstunden = Start + gearbeitet + Tagessoll je Urlaubs-/Krank-/Feiertag − Tagessoll je Wochentag; „Frei“ ohne Gutschrift
  //   Resturlaub = Start + Urlaubstage pro Jahr ab jedem neuen Jahr − eingetragene Urlaubstage
  // stempel: gültige und wartende; gerechnet wird nur mit gültigen, wartende Nachträge machen einen Tag nur „nicht offen“
  function konto(p, start, stempel, abwesend) {
    const ab = startTag(p, start);
    if (!ab) return null;
    const gestern = tagPlus(tagVon(new Date()), -1);
    const arbeit = {};
    auswerten(stempel.filter((s) => s.status === 'gueltig')).forEach((t) => { arbeit[t.tag] = t.arbeitMs / 3600000; });
    const weg = {};
    abwesend.forEach((x) => { weg[x.tag] = x.art; });
    const tagessoll = {};
    function sollAm(tag) {
      const mon = tag.slice(0, 7);
      if (!(mon in tagessoll)) {
        let n = 0;
        for (let d = mon + '-01'; d.startsWith(mon); d = tagPlus(d, 1)) if (wochentag(d) <= 5) n++;
        tagessoll[mon] = p.soll_std_monat / n;
      }
      return tagessoll[mon];
    }
    const monat = gestern.slice(0, 7);
    let ue = start ? Number(start.ueberstunden) : 0, monatIst = 0, monatSoll = 0;
    const mitKonto = p.ueberstundenkonto !== false && !!p.soll_std_monat;
    if (mitKonto) {
      for (let d = ab; d <= gestern; d = tagPlus(d, 1)) {
        const ts = wochentag(d) <= 5 ? sollAm(d) : 0;
        const gut = ts && (feiertag(d) || weg[d] === 'urlaub' || weg[d] === 'krank') ? ts : 0;
        const ist = (arbeit[d] || 0) + gut;
        ue += ist - ts;
        if (d.startsWith(monat)) { monatIst += ist; monatSoll += ts; }
      }
    }
    let urlaubRest = null;
    if (p.urlaub_tage_jahr !== null && p.urlaub_tage_jahr !== undefined) {
      urlaubRest = start ? Number(start.urlaub_rest) : 0;
      for (let j = Number(ab.slice(0, 4)) + 1; j <= new Date().getFullYear(); j++) urlaubRest += Number(p.urlaub_tage_jahr);
      urlaubRest -= abwesend.filter((x) => x.art === 'urlaub' && x.tag >= ab).length;
    }
    return { ab, start: start || null, ueberstunden: mitKonto ? ue : null, monatIst, monatSoll, urlaubRest,
      offen: offeneTage(ab, gestern, stempel, abwesend) };
  }

  // Konto für einen Mitarbeiter anlegen; das vorläufige Kennwort wird nur hier einmal gezeigt
  function kontoFormular(fertig) {
    const d = el('details', 'st-karte st-formular');
    d.append(el('summary', null, 'Konto für Mitarbeiter anlegen'));
    const f = el('form', 'st');
    const name = el('input'); name.type = 'text'; name.required = true; name.placeholder = 'Vor- und Nachname';
    const mail = el('input'); mail.type = 'email'; mail.required = true; mail.autocapitalize = 'off'; mail.placeholder = 'name@beispiel.de';
    const l1 = el('label', null, 'Name'); l1.append(name);
    const l2 = el('label', null, 'E-Mail'); l2.append(mail);
    const knopf = el('button', null, 'Konto anlegen'); knopf.type = 'submit';
    const meldung = el('div', 'st');
    f.append(el('p', 'klein', 'Der Mitarbeiter sieht danach nur „Stempeln“. Beim ersten Anmelden richtet er den 6-stelligen Code ein; das Kennwort kann er danach unten über „Kennwort ändern“ ersetzen.'),
      l1, l2, knopf, meldung);
    d.append(f);
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      knopf.disabled = true;
      meldung.replaceChildren();
      const { data, error } = await window.sb.functions.invoke('konto-anlegen', { body: { name: name.value, email: mail.value } });
      knopf.disabled = false;
      let fehler = data && data.fehler;
      if (error && !fehler) {
        try { fehler = (await error.context.json()).fehler; } catch (e) { fehler = fehlerText(error); }
      }
      if (fehler && /already been registered/i.test(fehler)) fehler = 'Für diese E-Mail-Adresse gibt es schon ein Konto. Bitte eine andere Adresse nehmen. (' + fehler + ')';
      if (fehler) { meldung.replaceChildren(el('div', 'st-hinweis fehler', fehler)); return; }
      const k = el('div', 'st-hinweis ok');
      k.append(el('div', null, 'Konto angelegt für ' + name.value + ' (' + data.email + ').'),
        el('div', null, 'Vorläufiges Kennwort (nur jetzt sichtbar, bitte weitergeben):'),
        el('div', 'st-kennwort', data.passwort),
        el('div', null, 'Anmelden unter christianaumeier.github.io/betriebs-app'));
      meldung.replaceChildren(k);
      name.value = ''; mail.value = '';
      fertig();
    });
    return d;
  }

  // CSV für Excel (Semikolon, deutsche Kommazahlen, UTF-8 mit BOM)
  function herunterladen(zeilen, dateiname) {
    const kopf = ['Name', 'Datum', 'Beginn', 'Ende', 'Pause (Std.)', 'Arbeitszeit (Std.)', 'Tätigkeit', 'Hinweis'];
    const text = [kopf].concat(zeilen).map((z) => z.map((f) => '"' + String(f).replace(/"/g, '""') + '"').join(';')).join('\r\n');
    const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = dateiname;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function zeigeStempeln(ziel) {
    const profil = window.Profil || {};
    if (profil.rolle === 'chef') zeigeChef(ziel); else zeigeMitarbeiter(ziel);
  }

  window.zeigeStempeln = zeigeStempeln;
})();
