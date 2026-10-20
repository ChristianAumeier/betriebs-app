// Anmeldung: E-Mail + Kennwort, danach zweiter Faktor (6-stelliger Code, TOTP).
// Auf dem iPhone setzt die „Passwörter“-App nach Face ID Kennwort und Code automatisch ein.
// Konten legt nur Christian im Supabase-Dashboard an (Selbstregistrierung ist aus).

(function () {
  const SUPABASE_URL = 'https://trwazyqryqdjbfggaufd.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_9zKcwyfgNlg19tYQDpivLQ_4j_JkxOc'; // öffentlich, darf in den Code
  const SPEICHER_SCHLUESSEL = 'sb-trwazyqryqdjbfggaufd-auth-token';

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });
  window.sb = sb; // für die Bereiche, die später Daten holen

  let ziel = null;
  let fertigMelden = null;

  // ---------- Hilfen ----------
  function el(tag, attrs, text) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = text;
    return e;
  }

  const UEBERSETZUNG = {
    invalid_credentials: 'E-Mail oder Kennwort ist falsch.',
    mfa_verification_failed: 'Der Code stimmt nicht. Bitte den gerade aktuellen Code nehmen.',
    mfa_challenge_expired: 'Der Code ist abgelaufen. Bitte noch einmal versuchen.',
    email_not_confirmed: 'Die E-Mail-Adresse ist noch nicht bestätigt.',
    same_password: 'Das neue Kennwort muss sich vom alten unterscheiden.',
    weak_password: 'Das Kennwort ist zu schwach.',
    over_request_rate_limit: 'Zu viele Versuche. Bitte ein paar Minuten warten.',
    user_banned: 'Dieses Konto ist gesperrt.'
  };

  // Zeigt eine verständliche Meldung und immer den Originaltext vom Server
  function fehlerKasten(fehler) {
    const box = el('div', { class: 'fehler', role: 'alert' });
    let text = UEBERSETZUNG[fehler && fehler.code];
    if (!text && fehler && fehler.name === 'AuthRetryableFetchError') text = 'Keine Verbindung zum Server. Ist das Handy online?';
    box.append(document.createTextNode(text || 'Das hat nicht geklappt.'));
    const original = (fehler && (fehler.message || String(fehler))) || '';
    if (original) box.append(el('span', { class: 'original' }, 'Meldung vom Server: ' + original));
    return box;
  }

  function seite(titel) {
    const box = el('div', { class: 'an' });
    if (titel) box.append(el('h2', null, titel));
    ziel.replaceChildren(box);
    return box;
  }

  function knopf(text, leise) {
    return el('button', { type: 'submit', class: leise ? 'leise' : '' }, text);
  }

  async function laeuft(button, arbeit) {
    button.disabled = true;
    try { return await arbeit(); } finally { button.disabled = false; }
  }

  // Liest die auf dem Gerät gespeicherte Sitzung, ohne Netz
  function gespeicherteSitzungMitCode() {
    try {
      const roh = localStorage.getItem(SPEICHER_SCHLUESSEL);
      if (!roh) return false;
      const token = JSON.parse(roh).access_token;
      const teil = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(teil)).aal === 'aal2';
    } catch (e) {
      return false;
    }
  }

  // ---------- Ablauf ----------
  async function start(zielElement, fertig) {
    ziel = zielElement;
    fertigMelden = fertig;
    seite().append(el('p', { class: 'klein' }, 'Einen Moment …'));

    if (!navigator.onLine) return ohneNetz();
    let ergebnis;
    try {
      ergebnis = await sb.auth.getSession();
    } catch (e) {
      return ohneNetz();
    }
    if (ergebnis.error && ergebnis.error.name === 'AuthRetryableFetchError') return ohneNetz();
    if (!ergebnis.data.session) return zeigeAnmelden();
    return weiterNachKennwort();
  }

  function ohneNetz() {
    if (gespeicherteSitzungMitCode()) return fertigMelden({ offline: true });
    const box = seite('Anmelden');
    box.append(el('p', null, 'Ohne Internet ist keine Anmeldung möglich. Bitte mit Netz noch einmal öffnen.'));
    const b = el('button', { type: 'button' }, 'Nochmal versuchen');
    b.addEventListener('click', () => start(ziel, fertigMelden));
    box.append(b);
  }

  async function weiterNachKennwort() {
    const { data, error } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) {
      const box = seite('Anmelden');
      box.append(fehlerKasten(error));
      return;
    }
    if (data.currentLevel === 'aal2') return fertigMelden({ offline: false });
    if (data.nextLevel === 'aal2') return zeigeCode();
    return zeigeEinrichtung();
  }

  function zeigeAnmelden() {
    const box = seite('Anmelden');
    const form = el('form');
    const mail = el('input', { type: 'email', name: 'email', autocomplete: 'username', required: '', inputmode: 'email' });
    const kw = el('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: '' });
    const l1 = el('label', null, 'E-Mail'); l1.append(mail);
    const l2 = el('label', null, 'Kennwort'); l2.append(kw);
    const b = knopf('Anmelden');
    const meldung = el('div');
    form.append(l1, l2, meldung, b);
    form.style.display = 'contents';
    box.append(form, el('p', { class: 'klein' }, 'Auf dem iPhone füllt die Passwörter-App E-Mail und Kennwort nach Face ID aus.'));

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      laeuft(b, async () => {
        meldung.replaceChildren();
        const { error } = await sb.auth.signInWithPassword({ email: mail.value.trim(), password: kw.value });
        if (error) { meldung.append(fehlerKasten(error)); return; }
        await weiterNachKennwort();
      });
    });
    mail.focus();
  }

  function codeFeld() {
    return el('input', {
      class: 'code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
      pattern: '[0-9]{6}', maxlength: '6', required: '', placeholder: '••••••'
    });
  }

  async function zeigeCode() {
    const box = seite('Bestätigungscode');
    box.append(el('p', null, 'Bitte den 6-stelligen Code eingeben. Auf dem iPhone schlägt die Passwörter-App ihn über der Tastatur vor.'));
    const form = el('form');
    form.style.display = 'contents';
    const code = codeFeld();
    const meldung = el('div');
    const b = knopf('Bestätigen');
    form.append(code, meldung, b);
    const weg = el('button', { type: 'button', class: 'leise' }, 'Mit anderem Konto anmelden');
    weg.addEventListener('click', abmelden);
    box.append(form, weg);

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      laeuft(b, async () => {
        meldung.replaceChildren();
        const faktoren = await sb.auth.mfa.listFactors();
        if (faktoren.error) { meldung.append(fehlerKasten(faktoren.error)); return; }
        const faktor = faktoren.data.totp[0];
        if (!faktor) return zeigeEinrichtung();
        const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: faktor.id, code: code.value.trim() });
        if (error) { meldung.append(fehlerKasten(error)); code.value = ''; code.focus(); return; }
        fertigMelden({ offline: false });
      });
    });
    code.focus();
  }

  async function zeigeEinrichtung() {
    const box = seite('Zweiten Faktor einrichten');
    box.append(el('p', null, 'Einmalig: Ein Code-Generator wird in der Passwörter-App gespeichert. Danach füllt das iPhone den Code bei der Anmeldung nach Face ID selbst aus.'));
    const lade = el('p', { class: 'klein' }, 'Wird vorbereitet …');
    box.append(lade);

    // Halb fertige Einrichtungen von früher entfernen
    const faktoren = await sb.auth.mfa.listFactors();
    if (faktoren.error) { lade.replaceWith(fehlerKasten(faktoren.error)); return; }
    for (const f of faktoren.data.all) {
      if (f.factor_type === 'totp' && f.status !== 'verified') await sb.auth.mfa.unenroll({ factorId: f.id });
    }

    const { data, error } = await sb.auth.mfa.enroll({
      factorType: 'totp',
      issuer: 'Betrieb Aumeier',
      friendlyName: 'Code ' + new Date().toISOString().slice(0, 16)
    });
    if (error) { lade.replaceWith(fehlerKasten(error)); return; }
    lade.remove();

    box.append(el('p', null, 'Schritt 1 – am iPhone:'));
    box.append(el('a', { class: 'knopf', href: data.totp.uri }, 'Code zur Passwörter-App hinzufügen'));
    box.append(el('p', { class: 'klein' }, 'Die Passwörter-App öffnet sich. Dort den Eintrag für diese App wählen (oder neu anlegen) und sichern. Dann hierher zurückkehren.'));
    box.append(el('p', { class: 'klein' }, 'Am PC stattdessen diesen QR-Code mit der iPhone-Kamera scannen:'));
    const qr = el('div', { class: 'qr' });
    qr.append(el('img', { src: data.totp.qr_code, alt: 'QR-Code für den Code-Generator' }));
    box.append(qr, el('p', { class: 'geheim' }, data.totp.secret));

    box.append(el('p', null, 'Schritt 2 – den angezeigten 6-stelligen Code eingeben:'));
    const form = el('form');
    form.style.display = 'contents';
    const code = codeFeld();
    const meldung = el('div');
    const b = knopf('Einrichtung abschließen');
    form.append(code, meldung, b);
    box.append(form);

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      laeuft(b, async () => {
        meldung.replaceChildren();
        const r = await sb.auth.mfa.challengeAndVerify({ factorId: data.id, code: code.value.trim() });
        if (r.error) { meldung.append(fehlerKasten(r.error)); code.value = ''; return; }
        fertigMelden({ offline: false });
      });
    });
  }

  function kennwortAendern(zielElement, zurueck) {
    ziel = zielElement;
    const box = seite('Kennwort ändern');
    box.append(el('p', null, 'Das iPhone schlägt ein sicheres Kennwort vor und speichert es in der Passwörter-App.'));
    const form = el('form');
    form.style.display = 'contents';
    // verstecktes Benutzerfeld, damit die Passwörter-App weiß, zu welchem Konto das Kennwort gehört
    const user = el('input', { type: 'email', autocomplete: 'username', hidden: '' });
    sb.auth.getSession().then(({ data }) => { if (data.session) user.value = data.session.user.email; });
    const kw = el('input', { type: 'password', autocomplete: 'new-password', required: '', minlength: '12' });
    const l = el('label', null, 'Neues Kennwort (mindestens 12 Zeichen)'); l.append(kw);
    const meldung = el('div');
    const b = knopf('Kennwort speichern');
    form.append(user, l, meldung, b);
    const z = el('button', { type: 'button', class: 'leise' }, 'Zurück');
    z.addEventListener('click', zurueck);
    box.append(form, z);

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      laeuft(b, async () => {
        meldung.replaceChildren();
        const { error } = await sb.auth.updateUser({ password: kw.value });
        if (error) { meldung.append(fehlerKasten(error)); return; }
        meldung.append(el('div', { class: 'ok' }, 'Kennwort geändert.'));
        kw.value = '';
      });
    });
    kw.focus();
  }

  async function abmelden() {
    try { await sb.auth.signOut({ scope: 'local' }); } catch (e) { /* ohne Netz: lokal trotzdem weg */ }
    try { localStorage.removeItem(SPEICHER_SCHLUESSEL); } catch (e) { /* egal */ }
    location.hash = '';
    location.reload();
  }

  async function benutzerEmail() {
    try {
      const { data } = await sb.auth.getSession();
      return data.session ? data.session.user.email : '';
    } catch (e) {
      return '';
    }
  }

  window.Anmeldung = { start, abmelden, kennwortAendern, benutzerEmail };
})();
