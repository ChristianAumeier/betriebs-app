// Edge Function „push-senden“: schickt Web-Push-Mitteilungen an alle angemeldeten Geräte.
// Aufgerufen nur von der Datenbank (intern.push_ausloesen über pg_net) mit dem Geheimnis
// `push_ausloeser` im Kopf `x-push-ausloeser`. Schlüssel kommen aus dem Vault (public.push_geheimnisse,
// nur für service_role). verify_jwt ist aus, die Funktion prüft das Geheimnis selbst.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

type Nachricht = { titel: string; text: string; ziel?: string };

Deno.serve(async (req: Request) => {
  const antwort = (status: number, daten: unknown) =>
    new Response(JSON.stringify(daten), { status, headers: { "Content-Type": "application/json" } });

  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });
    const { data: g, error: ge } = await sb.rpc("push_geheimnisse");
    if (ge || !g) return antwort(500, { fehler: "Schlüssel nicht lesbar: " + (ge?.message ?? "leer") });
    if (req.headers.get("x-push-ausloeser") !== g.ausloeser) return antwort(401, { fehler: "nicht erlaubt" });

    const { nachrichten, nur_user } = (await req.json()) as { nachrichten: Nachricht[]; nur_user?: string | null };
    if (!Array.isArray(nachrichten) || nachrichten.length === 0) return antwort(200, { gesendet: 0 });

    webpush.setVapidDetails("https://christianaumeier.github.io/betriebs-app/", g.oeffentlich, g.privat);

    let abfrage = sb.from("push_abos").select("id, endpoint, p256dh, auth");
    if (nur_user) abfrage = abfrage.eq("user_id", nur_user);
    const { data: abos, error: ae } = await abfrage;
    if (ae) return antwort(500, { fehler: "Geräte nicht lesbar: " + ae.message });

    let gesendet = 0;
    const fehler: string[] = [];
    for (const abo of abos ?? []) {
      let ok = true;
      for (const n of nachrichten) {
        try {
          await webpush.sendNotification(
            { endpoint: abo.endpoint, keys: { p256dh: abo.p256dh, auth: abo.auth } },
            JSON.stringify(n),
            { TTL: 86400, urgency: "high" },
          );
          gesendet++;
        } catch (e) {
          ok = false;
          const code = (e as { statusCode?: number }).statusCode;
          const text = (e as { body?: string; message?: string }).body || (e as Error).message;
          fehler.push(code + " " + text);
          if (code === 404 || code === 410) {
            await sb.from("push_abos").delete().eq("id", abo.id); // Gerät gibt es nicht mehr
            break;
          }
          await sb.from("push_abos").update({ fehler: (code ?? "") + " " + text }).eq("id", abo.id);
        }
      }
      if (ok) await sb.from("push_abos").update({ zuletzt_ok: new Date().toISOString(), fehler: null }).eq("id", abo.id);
    }
    return antwort(200, { geraete: abos?.length ?? 0, gesendet, fehler });
  } catch (e) {
    return antwort(500, { fehler: String(e) });
  }
});
