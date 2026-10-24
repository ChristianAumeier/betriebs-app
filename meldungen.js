// Störungsmeldungen und Push-Mitteilungen.
// Die Datenbank prüft alle 5 Minuten (supabase/006_stoerungen_push.sql) und führt Tabelle `stoerungen`:
//   wichtig = Push-Mitteilung aufs Handy (beim Auftreten und wenn behoben) und Meldung in der App
//   hinweis = nur Meldung in der App
// Hier: Meldungsleiste für die Startseite und die Karte „Mitteilungen“ (an/aus/Test).

(function () {
  // Öffentlicher Teil des Schlüsselpaars für Web-Push (darf in den Code; der geheime Teil liegt im Supabase Vault)
  const VAPID_OEFFENTLICH = 'BFPYzUD6InjG6IlAuJn5NBh7nu5zKI31w47Wme3cfPwle4KGkYVSDGZNLN6yfWEufG_AvWERG2CBfVbdr6xaWOE';

  function el(tag, klasse, text) {
    const e = document.createElement(tag);
    if (klasse) e.className = klasse;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function fehlerText(e) {
    return (e && e.message) ? e.message + (e.code ? ' (' + e.code + ')' : '') : String(e);
  }
  function seitText(iso) {
    const d = new Date(iso);
    const heute = new Date().toDateString() === d.toDateString();
    return 'seit ' + (heute ? '' : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' ') +
      d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
  }

  function zeitText(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' ' +
      d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
  }

  // ---------- Meldungsleiste ----------
  // Zeigt alle offenen Störungen und dazu wichtige, die schon behoben, aber noch nicht gelesen sind.
  // Wichtige verschwinden erst, wenn sie behoben UND gelesen sind.
  function leiste() {
    const box = el('div', 'ml-leiste');
    function laden() {
      window.sb.from('stoerungen').select('id, bereich, kategorie, text, seit, behoben_am, gelesen_am, gelesen_email')
        .or('behoben_am.is.null,and(kategorie.eq.wichtig,gelesen_am.is.null)')
        .order('seit', { ascending: false })
        .then(({ data, error }) => {
          box.replaceChildren();
          if (error) { box.append(el('div', 'ml-meldung fehler', 'Meldungen konnten nicht geladen werden: ' + fehlerText(error))); return; }
          const rang = (s) => (s.kategorie === 'wichtig' ? (s.gelesen_am ? 1 : 0) : 2);
          (data || []).sort((a, b) => rang(a) - rang(b)).forEach((s) => box.append(meldung(s)));
        });
    }
    function meldung(s) {
      const m = el('div', 'ml-meldung ' + s.kategorie + (s.behoben_am ? ' behoben' : ''));
      const kopf = el('div', 'kopf');
      kopf.append(el('span', 'marke', s.kategorie === 'wichtig' ? 'Wichtig' : 'Hinweis'), el('span', 'bereich', s.bereich),
        el('span', 'seit', seitText(s.seit)));
      m.append(kopf, el('div', 'text', s.text));
      if (s.behoben_am) m.append(el('div', 'zusatz', 'Wieder in Ordnung seit ' + zeitText(s.behoben_am) + '.'));
      if (s.kategorie === 'wichtig') {
        if (s.gelesen_am) {
          m.append(el('div', 'zusatz', 'Gelesen ' + zeitText(s.gelesen_am) + (s.gelesen_email ? ' von ' + s.gelesen_email : '') + '.'));
        } else {
          const b = el('button', 'gelesen', 'Gelesen');
          b.type = 'button';
          b.addEventListener('click', async () => {
            b.disabled = true;
            const { error } = await window.sb.rpc('stoerung_gelesen', { p_id: s.id });
            if (error) { b.disabled = false; m.append(el('div', 'zusatz', 'Konnte nicht speichern: ' + fehlerText(error))); return; }
            laden();
          });
          m.append(b);
        }
      }
      return m;
    }
    laden();
    return box;
  }

  // ---------- Push auf diesem Gerät ----------
  function pushMoeglich() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }
  function istInstalliert() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  }
  function schluesselBytes(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const roh = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(roh, (c) => c.charCodeAt(0));
  }
  function geraetName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android';
    if (/Windows/.test(ua)) return 'PC (Windows)';
    if (/Mac/.test(ua)) return 'Mac';
    return 'Gerät';
  }
  // Service Worker abwarten, aber höchstens 5 Sekunden (sonst hinge die Karte, wenn er nicht läuft)
  function bereit() {
    return Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, nein) => setTimeout(() => nein(new Error('Der Hintergrunddienst der App (Service Worker) läuft nicht. App einmal schließen und neu öffnen.')), 5000))
    ]);
  }
  async function abo() {
    const reg = await bereit();
    return reg.pushManager.getSubscription();
  }
  async function speichern(sub) {
    const j = sub.toJSON();
    const { error } = await window.sb.rpc('push_abo_speichern', {
      p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_geraet: geraetName()
    });
    if (error) throw error;
  }
  async function einschalten() {
    const erlaubnis = await Notification.requestPermission();
    if (erlaubnis !== 'granted') throw new Error('Mitteilungen wurden nicht erlaubt (' + erlaubnis + '). Ändern geht in den iPhone-Einstellungen unter „Mitteilungen“ → „Betrieb Aumeier“.');
    const reg = await bereit();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: schluesselBytes(VAPID_OEFFENTLICH) });
    await speichern(sub);
  }
  async function ausschalten() {
    const sub = await abo();
    if (!sub) return;
    await window.sb.rpc('push_abo_loeschen', { p_endpoint: sub.endpoint });
    await sub.unsubscribe();
  }

  // Beim Start: vorhandene Anmeldung für Mitteilungen noch einmal speichern (z. B. nach neuer Anmeldung)
  async function auffrischen() {
    try {
      if (!pushMoeglich() || Notification.permission !== 'granted') return;
      const sub = await abo();
      if (sub) await speichern(sub);
    } catch (e) { /* ohne Netz egal, nächster Start versucht es wieder */ }
  }

  // ---------- Karte „Mitteilungen“ für die Startseite ----------
  // titel: für Fahrer und Transportfirma ein anderer (die bekommen keine Störungen, sondern Fuhren)
  function karte(titel) {
    const k = el('div', 'ml-karte');
    k.append(el('div', 'titel', titel || 'Mitteilungen bei wichtigen Störungen'));
    const zustand = el('div', 'zustand', '…');
    const knoepfe = el('div', 'knoepfe');
    const meldung = el('div');
    k.append(zustand, knoepfe, meldung);

    function knopf(text, arbeit, leise) {
      const b = el('button', leise ? 'leise' : '', text);
      b.type = 'button';
      b.addEventListener('click', async () => {
        b.disabled = true;
        meldung.replaceChildren();
        try { await arbeit(); } catch (e) { meldung.append(el('div', 'ml-meldung fehler', fehlerText(e))); }
        b.disabled = false;
        zeigen();
      });
      return b;
    }

    async function zeigen() {
      knoepfe.replaceChildren();
      if (!pushMoeglich()) {
        zustand.textContent = 'Dieses Gerät kann keine Mitteilungen von der App bekommen.';
        return;
      }
      if (/iPhone|iPad/.test(navigator.userAgent) && !istInstalliert()) {
        zustand.textContent = 'Am iPhone gehen Mitteilungen nur in der App vom Home-Bildschirm, nicht in Safari.';
        return;
      }
      let sub = null;
      try { sub = await abo(); } catch (e) { /* kein Service Worker */ }
      if (sub && Notification.permission === 'granted') {
        zustand.textContent = titel ? 'An: Dieses Gerät bekommt Mitteilungen.' : 'An: Dieses Gerät bekommt wichtige Störungen als Mitteilung.';
        knoepfe.append(
          knopf('Testmitteilung senden', async () => {
            const { error } = await window.sb.rpc('push_test');
            if (error) throw error;
            meldung.append(el('div', 'ml-meldung ok', 'Gesendet. Die Mitteilung sollte in wenigen Sekunden kommen.'));
          }),
          knopf('Ausschalten', ausschalten, true));
      } else if (Notification.permission === 'denied') {
        zustand.textContent = 'Mitteilungen sind für diese App gesperrt. Ändern in den Einstellungen des Geräts (am iPhone: Einstellungen → Mitteilungen → „Betrieb Aumeier“).';
      } else {
        zustand.textContent = 'Aus: Dieses Gerät bekommt noch keine Mitteilungen.';
        knoepfe.append(knopf('Mitteilungen erlauben', einschalten));
      }
    }
    zeigen();
    return k;
  }

  window.Meldungen = { leiste, karte, auffrischen };
})();
