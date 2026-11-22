// Sonde : regarde ce que l'API non officielle d'ESPN renvoie (buteurs ? passeurs ? Süper Lig ?).
// N'écrit que de petits extraits dans data/probe/ pour analyse. Ne touche pas aux données de l'app.
import fs from "node:fs/promises";
import path from "node:path";

const OUT = process.env.OUT_DIR || "data/probe";
const BASE = process.env.ESPN_BASE || "https://site.api.espn.com/apis/site/v2/sports/soccer";
const LEAGUES = (process.env.PROBE_LEAGUES || "fra.1,tur.1,eng.1").split(",");

async function save(name, obj) {
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, name), JSON.stringify(obj, null, 1).slice(0, 150000));
}
async function get(url) {
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (club-stats-probe)" } });
    const t = await r.text();
    let json = null; try { json = JSON.parse(t); } catch {}
    return { status: r.status, json, bytes: t.length };
  } catch (e) { return { status: 0, error: String(e.message || e) }; }
}
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");
const to = new Date(), from = new Date(Date.now() - 21 * 864e5);

const log = {};
for (const slug of LEAGUES) {
  const r = await get(`${BASE}/${slug}/scoreboard?dates=${ymd(from)}-${ymd(to)}&limit=100`);
  log[slug] = { status: r.status, error: r.error || null, events: r.json?.events?.length ?? null };
  const done = (r.json?.events || []).filter(e => e.status?.type?.completed);
  log[slug].completed = done.length;
  const ev = done[done.length - 1];
  if (!ev) continue;
  const comp = ev.competitions?.[0];
  await save(`${slug}-scoreboard-event.json`, {
    id: ev.id, name: ev.name, date: ev.date,
    teams: comp?.competitors?.map(c => ({ team: c.team?.displayName, score: c.score })),
    details: comp?.details
  });
  const s = await get(`${BASE}/${slug}/summary?event=${ev.id}`);
  log[slug].summary = { status: s.status, error: s.error || null, topKeys: s.json ? Object.keys(s.json) : null };
  if (s.json) {
    const j = s.json;
    await save(`${slug}-summary-sample.json`, {
      keyEvents: (j.keyEvents || []).slice(0, 30),
      goalCommentary: (j.commentary || []).filter(c => /goal|assist/i.test(JSON.stringify(c))).slice(0, 12),
      headerDetails: j.header?.competitions?.[0]?.details?.slice?.(0, 15) ?? null
    });
  }
}
await save("summary.json", { at: new Date().toISOString(), log });
console.log(JSON.stringify(log, null, 1));
