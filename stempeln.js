// Bereich „Stempeln“: Arbeitszeiten der Mitarbeiter (supabase/010_stempeln.sql).
// Mitarbeiter: Start, Pause, Weiter, Stopp; vergessene Zeiten nachtragen (wartet auf Freigabe);
// kurz eintragen, was am Tag gemacht wurde (supabase/011_taetigkeiten.sql).
// Chef (Christian, Carolin): wer gerade arbeitet, Nachträge freigeben, Stunden je Monat, Liste fürs Lohnbüro,
// Konten für Mitarbeiter anlegen (Edge Function konto-anlegen).
// Stempel werden nie gelöscht oder geändert; die Zeit beim Knopfdruck setzt der Server.

(function () {
  const ABFRAGE_MS = 60000;
  const ARTEN = { start: 'Start', pause: 'Pause', weiter: 'Weiter nach Pause', stopp: 'Stopp' };

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
      if (!tage[t]) tage[t] = { tag: t, beginn: s.zeit, ende: null, arbeitMs: 0, pauseMs: 0, nachtrag: false, offen: false, stoppFehlt: false, laeuft: false };
      return tage[t];
    }
    for (const s of liste) {
      const ms = new Date(s.zeit).getTime();
      if (s.art === 'start' || (s.art === 'weiter' && z === 'aus')) {
        if (z !== 'aus' && tag) tag.stoppFehlt = true;
        tag = zu(s); z = 'arbeitet'; abschnitt = ms;
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
    if (t.offen) marken.push('Nachtrag wartet auf Freigabe');
    else if (t.nachtrag) marken.push('mit Nachtrag');
    if (marken.length) z.append(el('span', 'marke', marken.join(' · ')));
    if (taetigkeit) z.append(el('span', 'taetigkeit', taetigkeit));
    return z;
  }

  // Formular „Zeit nachtragen“; personen = null → für sich selbst
  function nachtragFormular(personen, fertig) {
    const f = el('form', 'st-karte st-formular');
    f.append(el('h3', null, personen ? 'Zeit eintragen (gilt sofort)' : 'Zeit nachtragen'));
    if (!personen) f.append(el('p', 'klein', 'Vergessen zu stempeln? Hier eintragen. Der Nachtrag gilt, sobald Christian ihn freigibt.'));
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
    const knopf = el('button', null, personen ? 'Eintragen' : 'Nachtrag senden'); knopf.type = 'submit';
    const meldung = el('div');
    f.append(knopf, meldung);
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      knopf.disabled = true;
      meldung.replaceChildren();
      const wann = new Date(datum.value + 'T' + zeit.value);
      const { error } = await window.sb.rpc('stempel_nachtragen', {
        p_art: art.value, p_zeit: wann.toISOString(), p_grund: grund.value, p_user: wer ? wer.value : null
      });
      knopf.disabled = false;
      if (error) { meldung.replaceChildren(fehlerKasten('Nicht gespeichert', error)); return; }
      grund.value = ''; zeit.value = '';
      meldung.replaceChildren(el('div', 'st-hinweis ok', personen ? 'Eingetragen.' : 'Gesendet. Wartet auf Freigabe.'));
      fertig();
    });
    return f;
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
  function zeigeMitarbeiter(ziel) {
    const box = el('div', 'st');
    const oben = el('div', 'st');
    const liste = el('div', 'st');
    let uid = null;
    let taetigkeiten = {};
    const tk = taetigkeitKarte();
    box.append(oben, tk.karte, nachtragFormular(null, () => holen()), liste);
    ziel.replaceChildren(box);
    let laeuft = false;

    // „Was hast du gemacht?“ – freier Text, für heute oder einen Tag davor
    function taetigkeitKarte() {
      const f = el('form', 'st-karte st-formular');
      f.append(el('h3', null, 'Was hast du gemacht?'));
      const datum = el('input'); datum.type = 'date'; datum.value = tagVon(new Date()); datum.max = datum.value; datum.required = true;
      const text = el('textarea'); text.rows = 2; text.maxLength = 500; text.required = true;
      text.placeholder = 'z. B. Feld gegrubbert, Maschinen gewaschen';
      const l1 = el('label', null, 'Tag'); l1.append(datum);
      const l2 = el('label', null, 'Tätigkeit'); l2.append(text);
      const knopf = el('button', null, 'Speichern'); knopf.type = 'submit';
      const meldung = el('div');
      f.append(l1, l2, knopf, meldung);
      let geaendert = false;
      text.addEventListener('input', () => { geaendert = true; });
      datum.addEventListener('change', () => { geaendert = false; fuellen(); meldung.replaceChildren(); });
      function fuellen() { if (!geaendert && document.activeElement !== text) text.value = taetigkeiten[uid + '|' + datum.value] || ''; }
      f.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        knopf.disabled = true;
        const { error } = await window.sb.rpc('taetigkeit_speichern', { p_tag: datum.value, p_text: text.value });
        knopf.disabled = false;
        if (error) { meldung.replaceChildren(fehlerKasten('Nicht gespeichert', error)); return; }
        geaendert = false;
        meldung.replaceChildren(el('div', 'st-hinweis ok', 'Gespeichert.'));
        holen();
      });
      return { karte: f, fuellen, text, datum };
    }

    async function holen() {
      if (laeuft) return;
      laeuft = true;
      try {
        const ab = new Date(); ab.setDate(1); ab.setHours(0, 0, 0, 0); ab.setDate(ab.getDate() - 3);
        uid = uid || (await window.sb.auth.getUser()).data.user.id;
        const [s, t] = await Promise.all([
          window.sb.from('stempel').select('*').eq('user_id', uid).gte('zeit', ab.toISOString()).order('zeit'),
          window.sb.from('taetigkeiten').select('id, user_id, tag, text').eq('user_id', uid).gte('tag', tagVon(ab)).order('id')
        ]);
        if (s.error || t.error) throw s.error || t.error;
        taetigkeiten = taetigkeitenNach(t.data || []);
        tk.fuellen();
        zeichnen(s.data || []);
      } catch (e) {
        oben.replaceChildren(fehlerKasten('Zeiten konnten nicht geladen werden', e));
      } finally { laeuft = false; }
    }

    async function druecken(art, knopf) {
      knopf.disabled = true;
      const { error } = await window.sb.rpc('stempeln', { p_art: art });
      if (error) { oben.append(fehlerKasten('Hat nicht geklappt', error)); knopf.disabled = false; return; }
      await holen();
      // Nach Feierabend an die Tätigkeit erinnern
      if (art === 'stopp' && !taetigkeiten[uid + '|' + tagVon(new Date())]) {
        tk.datum.value = tagVon(new Date());
        oben.append(el('div', 'st-hinweis', 'Feierabend gestempelt. Bitte noch kurz eintragen, was du heute gemacht hast.'));
        tk.text.focus();
      }
    }

    function zeichnen(stempel) {
      const z = zustand(stempel);
      const tage = auswerten(stempel);
      const heute = tage.find((t) => t.tag === tagVon(new Date()));
      const karte = el('div', 'st-karte st-status ' + z.art);
      karte.append(el('div', 'gross',
        z.art === 'arbeitet' ? 'Arbeitet seit ' + uhr(z.seit) : z.art === 'pause' ? 'Pause seit ' + uhr(z.seit) : 'Nicht eingestempelt'));
      karte.append(el('div', 'klein', 'Heute gearbeitet: ' + stunden(heute ? heute.arbeitMs : 0)));
      const knoepfe = el('div', 'st-knoepfe');
      const plan = z.art === 'aus' ? [['start', 'Start']] : z.art === 'arbeitet' ? [['pause', 'Pause'], ['stopp', 'Stopp']] : [['weiter', 'Weiter'], ['stopp', 'Stopp']];
      plan.forEach(([art, text]) => {
        const k = el('button', 'st-knopf ' + art, text);
        k.addEventListener('click', () => druecken(art, k));
        knoepfe.append(k);
      });
      karte.append(knoepfe);
      const teile = [karte];
      if (z.art !== 'aus' && tagVon(z.seit) !== tagVon(new Date())) {
        teile.push(el('div', 'st-hinweis', 'Du bist seit ' + wannText(z.seit) + ' eingestempelt. Stopp vergessen? Dann unten den Stopp nachtragen.'));
      }
      oben.replaceChildren(...teile);

      const monat = tagVon(new Date()).slice(0, 7);
      const imMonat = tage.filter((t) => t.tag.startsWith(monat));
      const k = el('div', 'st-karte');
      k.append(el('h3', null, 'Meine Zeiten im ' + new Date().toLocaleDateString('de-DE', { month: 'long' })));
      k.append(el('div', 'st-summe', 'Zusammen: ' + stunden(imMonat.reduce((s, t) => s + t.arbeitMs, 0))));
      imMonat.slice().reverse().forEach((t) => k.append(tagesZeile(t, taetigkeiten[uid + '|' + t.tag])));
      const abgelehnt = stempel.filter((s) => s.status === 'abgelehnt');
      abgelehnt.forEach((s) => k.append(el('div', 'st-hinweis', 'Nachtrag abgelehnt: ' + ARTEN[s.art] + ' ' + wannText(s.zeit))));
      if (!imMonat.length) k.append(el('p', 'klein', 'Noch keine Zeiten in diesem Monat.'));
      liste.replaceChildren(k);
    }

    regelmaessig(box, holen);
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

    async function holen() {
      if (laeuft) return;
      laeuft = true;
      try {
        const von = new Date(jahr, monat, 1); von.setDate(von.getDate() - 2);
        const bis = new Date(jahr, monat + 1, 1); bis.setDate(bis.getDate() + 1);
        const kurz = new Date(); kurz.setDate(kurz.getDate() - 14);
        const [p, m, k, o, t] = await Promise.all([
          window.sb.from('personen').select('user_id, name, stempelt').eq('stempelt', true).order('name'),
          window.sb.from('stempel').select('*').gte('zeit', von.toISOString()).lt('zeit', bis.toISOString()).order('zeit'),
          window.sb.from('stempel').select('*').gte('zeit', kurz.toISOString()).order('zeit'),
          window.sb.from('stempel').select('*').eq('status', 'offen').order('zeit'),
          window.sb.from('taetigkeiten').select('id, user_id, tag, text').gte('tag', tagVon(von)).lt('tag', tagVon(bis)).order('id')
        ]);
        const fehler = p.error || m.error || k.error || o.error || t.error;
        if (fehler) throw fehler;
        if (!box.isConnected) return;
        zeichnen(p.data || [], m.data || [], k.data || [], o.data || [], taetigkeitenNach(t.data || []));
      } catch (e) {
        box.replaceChildren(fehlerKasten('Zeiten konnten nicht geladen werden', e));
      } finally { laeuft = false; }
    }

    function zeichnen(personen, imMonat, kuerzlich, offene, taetigkeiten) {
      const name = {};
      personen.forEach((p) => { name[p.user_id] = p.name; });
      const teile = [];

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
          zeile.append(el('span', 'punkt ' + (alt ? 'alt' : z.art)), el('span', 'name', p.name),
            el('span', 'zustand', (z.art === 'arbeitet' ? 'arbeitet seit ' + wannText(z.seit) : z.art === 'pause' ? 'Pause seit ' + wannText(z.seit) : 'nicht da') +
              (alt ? ' – Stopp vergessen?' : '')),
            el('span', 'std', heute ? stunden(heute.arbeitMs) : ''));
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
        const d = el('details', 'st-monat');
        d.open = offen.has(p.user_id);
        d.addEventListener('toggle', () => { if (d.open) offen.add(p.user_id); else offen.delete(p.user_id); });
        const sum = el('summary');
        sum.append(el('span', 'name', p.name), el('span', 'klein', tage.length + (tage.length === 1 ? ' Tag' : ' Tage')), el('span', 'std', stunden(summe)));
        if (tage.some((t) => t.stoppFehlt)) sum.append(el('span', 'marke', 'Stopp fehlt'));
        d.append(sum);
        tage.forEach((t) => {
          const taetigkeit = taetigkeiten[p.user_id + '|' + t.tag] || '';
          d.append(tagesZeile(t, taetigkeit));
          export_.push([p.name, t.tag.split('-').reverse().join('.'), uhr(t.beginn), t.ende ? uhr(t.ende) : '',
            dezimal(t.pauseMs), dezimal(t.arbeitMs), taetigkeit, [t.stoppFehlt ? 'Stopp fehlt' : '', t.nachtrag ? 'Nachtrag' : ''].filter(Boolean).join(', ')]);
        });
        if (!tage.length) d.append(el('p', 'klein', 'Keine Zeiten in diesem Monat.'));
        mk.append(d);
      });
      if (export_.length) {
        const dl = el('button', 'st-knopf leise', 'Liste fürs Lohnbüro herunterladen');
        dl.addEventListener('click', () => herunterladen(export_, 'Stunden ' + praefix + '.csv'));
        mk.append(dl);
      }
      teile.push(mk);

      const fuer = personen.map((p) => p.user_id + p.name).join();
      if (fuer !== nachtragFuer) { nachtragFuer = fuer; nachtragKarte = personen.length ? nachtragFormular(personen, () => holen()) : null; }
      if (nachtragKarte) teile.push(nachtragKarte);
      teile.push(kontoKarte);
      box.replaceChildren(...teile);
    }

    regelmaessig(box, holen);
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
