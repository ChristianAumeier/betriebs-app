// Edge Function „konto-anlegen“: Christian oder Carolin legen in der App ein Konto für einen Mitarbeiter an.
// Aufruf aus der App (supabase.functions.invoke) mit der Anmeldung des Aufrufers. verify_jwt ist aus,
// die Funktion prüft selbst, dass der Aufrufer Chef ist und mit Code angemeldet (public.ist_chef),
// legt das Konto bestätigt an (Trigger trägt es als mitarbeiter ein), setzt den Namen und gibt ein
// vorläufiges Kennwort zurück. Das Kennwort wird nirgends gespeichert, nur einmal in der App gezeigt.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Gut lesbar und abtippbar: ohne 0/O, 1/l/I
function kennwort(): string {
  const zeichen = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const zufall = crypto.getRandomValues(new Uint32Array(15));
  const z = Array.from(zufall, (n) => zeichen[n % zeichen.length]).join("");
  return z.slice(0, 5) + "-" + z.slice(5, 10) + "-" + z.slice(10);
}

Deno.serve(async (req: Request) => {
  const antwort = (status: number, daten: unknown) =>
    new Response(JSON.stringify(daten), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const aufrufer = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: chef, error: ce } = await aufrufer.rpc("ist_chef");
    if (ce) return antwort(401, { fehler: "Anmeldung nicht gültig: " + ce.message });
    if (chef !== true) return antwort(403, { fehler: "Nur für Christian und Carolin (mit Code angemeldet)" });

    const { email, name } = (await req.json()) as { email?: string; name?: string };
    const mail = (email ?? "").trim().toLowerCase();
    const n = (name ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return antwort(400, { fehler: "E-Mail-Adresse ist ungültig" });
    if (!n) return antwort(400, { fehler: "Bitte einen Namen angeben" });

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const passwort = kennwort();
    const { data: neu, error: ne } = await admin.auth.admin.createUser({ email: mail, password: passwort, email_confirm: true });
    if (ne || !neu?.user) return antwort(400, { fehler: "Konto nicht angelegt: " + (ne?.message ?? "unbekannt") });

    const { error: pe } = await admin.from("personen").update({ name: n }).eq("user_id", neu.user.id);
    if (pe) return antwort(500, { fehler: "Konto angelegt, Name nicht gesetzt: " + pe.message, passwort });

    return antwort(200, { passwort, email: mail });
  } catch (e) {
    return antwort(500, { fehler: String(e) });
  }
});
