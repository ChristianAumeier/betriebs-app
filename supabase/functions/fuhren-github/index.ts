// Edge Function „fuhren-github“: Verbindung zwischen den Fuhren (supabase/013_fuhren.sql) und dem privaten
// Repository ChristianAumeier/claude-gedaechtnis, in dem eine Claude-Routine die Scans liest.
//   aktion „weitergeben“ (von der Datenbank, Kopf x-push-ausloeser): Scans einer kompletten Fuhre als ein Commit
//     nach eingang/fuhren/<datum>_fuhre-<id>/ legen (plus fuhre.json). Das startet die Routine.
//   aktion „abgleichen“ (von der Datenbank, alle 10 Minuten): Ergebnisse der Routine aus eingang/ergebnisse/
//     fuhre-<id>.json holen und in die Fuhre übernehmen (public.fuhre_ergebnis_speichern).
//   aktion „excel“ (aus der App, nur Chef): Monats-Auswertung aus dem Repository herunterladen.
// Der GitHub-Schlüssel liegt nur im Vault (public.fuhren_geheimnisse, nur service_role). verify_jwt ist aus.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const REPO = "ChristianAumeier/claude-gedaechtnis";
const API = "https://api.github.com/repos/" + REPO;
const MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ENDUNG: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };

Deno.serve(async (req: Request) => {
  const antwort = (status: number, daten: unknown) =>
    new Response(JSON.stringify(daten), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const sb = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: g, error: ge } = await sb.rpc("fuhren_geheimnisse");
    if (ge || !g) return antwort(500, { fehler: "Schlüssel nicht lesbar: " + (ge?.message ?? "leer") });
    const body = await req.json() as { aktion?: string; fuhre_id?: number; monat?: string };
    const vonDatenbank = req.headers.get("x-push-ausloeser") === g.ausloeser;

    if (!g.github) return antwort(400, { fehler: "Der GitHub-Schlüssel ist noch nicht hinterlegt (in der App unter Bahnschwellen → Einstellungen)." });
    const gh = async (pfad: string, init: RequestInit = {}, roh = false) => {
      const r = await fetch(API + pfad, {
        ...init,
        headers: {
          "Authorization": "Bearer " + g.github,
          "Accept": roh ? "application/vnd.github.raw" : "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "betriebs-app",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      });
      if (!r.ok && r.status !== 404) throw new Error("GitHub " + r.status + ": " + (await r.text()).slice(0, 300));
      return r;
    };

    // ---------- weitergeben ----------
    if (body.aktion === "weitergeben") {
      if (!vonDatenbank) return antwort(401, { fehler: "nicht erlaubt" });
      const id = Number(body.fuhre_id);
      try {
        const { data: f, error: fe } = await sb.from("fuhren").select("*, ladestellen(name, vertrag)").eq("id", id).single();
        if (fe || !f) throw new Error("Fuhre nicht lesbar: " + (fe?.message ?? id));
        if (f.weitergegeben_am) return antwort(200, { schon: true });
        const { data: belege, error: be } = await sb.from("belege").select("*").eq("fuhre_id", id).is("ungueltig_am", null).order("id");
        if (be) throw new Error("Belege nicht lesbar: " + be.message);

        const ordner = "eingang/fuhren/" + f.datum + "_fuhre-" + id + "/";
        const zaehler: Record<string, number> = {};
        const eintraege: { path: string; mode: string; type: string; sha: string }[] = [];
        const dateien: { art: string; datei: string }[] = [];
        for (const b of belege ?? []) {
          const { data: blob, error: de } = await sb.storage.from("belege").download(b.pfad);
          if (de || !blob) throw new Error("Scan nicht lesbar (" + b.pfad + "): " + (de?.message ?? "leer"));
          zaehler[b.art] = (zaehler[b.art] ?? 0) + 1;
          const datei = b.art + "-" + zaehler[b.art] + "." + (ENDUNG[b.mime] ?? "bin");
          const inhalt = encodeBase64(new Uint8Array(await blob.arrayBuffer()));
          const r = await gh("/git/blobs", { method: "POST", body: JSON.stringify({ content: inhalt, encoding: "base64" }) });
          eintraege.push({ path: ordner + datei, mode: "100644", type: "blob", sha: (await r.json()).sha });
          dateien.push({ art: b.art, datei });
        }
        const info = {
          fuhre_id: id, datum: f.datum, lkw: f.lkw, fahrer_in_der_app: f.fahrer,
          ladestelle_in_der_app: f.ladestellen?.name ?? null, vertrag_in_der_app: f.ladestellen?.vertrag ?? null,
          // Gesetzt, wenn Christian die Fuhre trotz fehlender Belege abgeschlossen hat (Fehlen ist dann gewollt)
          ohne_fehlende_belege_abgeschlossen: f.abschluss_grund ?? null,
          dateien, ergebnis_ablegen_unter: "eingang/ergebnisse/fuhre-" + id + ".json",
        };
        const ib = await gh("/git/blobs", { method: "POST", body: JSON.stringify({ content: JSON.stringify(info, null, 2), encoding: "utf-8" }) });
        eintraege.push({ path: ordner + "fuhre.json", mode: "100644", type: "blob", sha: (await ib.json()).sha });

        // Ein Commit für die ganze Fuhre; bei gleichzeitigem Push einmal neu versuchen
        for (let versuch = 0; versuch < 3; versuch++) {
          const ref = await (await gh("/git/ref/heads/main")).json();
          const basis = await (await gh("/git/commits/" + ref.object.sha)).json();
          const baum = await (await gh("/git/trees", { method: "POST", body: JSON.stringify({ base_tree: basis.tree.sha, tree: eintraege }) })).json();
          const commit = await (await gh("/git/commits", { method: "POST", body: JSON.stringify({
            message: "Fuhre " + id + " vom " + f.datum + " zum Auslesen", tree: baum.sha, parents: [ref.object.sha],
          }) })).json();
          const r = await fetch(API + "/git/refs/heads/main", {
            method: "PATCH",
            headers: { "Authorization": "Bearer " + g.github, "Accept": "application/vnd.github+json", "User-Agent": "betriebs-app", "Content-Type": "application/json" },
            body: JSON.stringify({ sha: commit.sha }),
          });
          if (r.ok) break;
          if (versuch === 2 || r.status !== 422) throw new Error("GitHub " + r.status + ": " + (await r.text()).slice(0, 300));
        }
        await sb.from("fuhren").update({ weitergegeben_am: new Date().toISOString(), weitergabe_fehler: null }).eq("id", id);
        return antwort(200, { weitergegeben: id, dateien: dateien.length });
      } catch (e) {
        await sb.from("fuhren").update({ weitergabe_fehler: String(e).slice(0, 500) }).eq("id", id);
        return antwort(500, { fehler: String(e) });
      }
    }

    // ---------- abgleichen ----------
    if (body.aktion === "abgleichen") {
      if (!vonDatenbank) return antwort(401, { fehler: "nicht erlaubt" });
      const r = await gh("/contents/eingang/ergebnisse?ref=main");
      if (r.status === 404) return antwort(200, { uebernommen: 0 });
      const liste = await r.json() as { name: string; path: string; sha: string }[];
      const ids = liste.map((d) => /^fuhre-(\d+)\.json$/.exec(d.name)).filter(Boolean).map((m) => Number(m![1]));
      if (!ids.length) return antwort(200, { uebernommen: 0 });
      const { data: fuhren } = await sb.from("fuhren").select("id, ergebnis_sha").in("id", ids);
      const bekannt = new Map((fuhren ?? []).map((f) => [f.id, f.ergebnis_sha]));
      let uebernommen = 0;
      const fehler: string[] = [];
      for (const d of liste) {
        const m = /^fuhre-(\d+)\.json$/.exec(d.name);
        if (!m || !bekannt.has(Number(m[1])) || bekannt.get(Number(m[1])) === d.sha) continue;
        try {
          const e = JSON.parse(await (await gh("/contents/" + d.path + "?ref=main", {}, true)).text());
          const { error } = await sb.rpc("fuhre_ergebnis_speichern", { p_fuhre: Number(m[1]), p_e: e, p_sha: d.sha });
          if (error) throw new Error(error.message);
          uebernommen++;
        } catch (e) { fehler.push(d.name + ": " + String(e)); }
      }
      return antwort(200, { uebernommen, fehler });
    }

    // ---------- excel ----------
    if (body.aktion === "excel") {
      const aufrufer = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
        auth: { persistSession: false },
        global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      });
      const { data: chef } = await aufrufer.rpc("ist_chef");
      if (chef !== true) return antwort(403, { fehler: "Nur für Christian und Carolin (mit Code angemeldet)" });
      const m = /^(\d{4})-(\d{2})$/.exec(body.monat ?? "");
      if (!m) return antwort(400, { fehler: "Monat fehlt" });
      const name = "Auswertung Lieferscheine " + MONATE[Number(m[2]) - 1] + " " + m[1] + ".xlsx";
      const r = await gh("/contents/" + encodeURI("dokumente/lieferscheine-herbst/" + m[1] + "/" + name) + "?ref=main", {}, true);
      if (r.status === 404) return antwort(404, { fehler: "Für diesen Monat gibt es noch keine Excel-Auswertung im Cloud-Gedächtnis." });
      return antwort(200, { name, inhalt: encodeBase64(new Uint8Array(await r.arrayBuffer())) });
    }

    return antwort(400, { fehler: "Unbekannte Aktion" });
  } catch (e) {
    return antwort(500, { fehler: String(e) });
  }
});
