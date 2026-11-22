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
    return { status: r.status, json, text: t, bytes: t.length };
  } catch (e) { return { status: 0, error: String(e.message || e) }; }
}
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");

const log = {};
const d = n => ymd(new Date(Date.now() - n * 864e5));
const variants = [
  ["sans-parametres", ""],
  ["un-jour", `?dates=${d(1)}`],
  ["7-jours", `?dates=${d(7)}-${d(0)}`],
  ["21-jours-limit", `?dates=${d(21)}-${d(0)}&limit=100`]
];
for (const slug of LEAGUES) {
  log[slug] = { tries: [] };
  let ev = null;
  for (const [name, q] of variants) {
    const r = await get(`${BASE}/${slug}/scoreboard${q}`);
    const done = (r.json?.events || []).filter(e => e.status?.type?.completed);
    log[slug].tries.push({ name, status: r.status, error: r.error || null, events: r.json?.events?.length ?? null, completed: done.length,
                           body: r.status === 200 ? undefined : (r.text || "").slice(0, 200) });
    if (!ev && done.length) ev = done[done.length - 1];
  }
  if (!ev) continue;
  const comp = ev.competitions?.[0];
  await save(`${slug}-scoreboard-event.json`, {
    id: ev.id, name: ev.name, date: ev.date,
    teams: comp?.competitors?.map(c => ({ team: c.team?.displayName, score: c.score })),
    details: comp?.details
  });
  const sm = await get(`${BASE}/${slug}/summary?event=${ev.id}`);
  log[slug].summary = { status: sm.status, error: sm.error || null, body: sm.status === 200 ? undefined : (sm.text || "").slice(0, 200), topKeys: sm.json ? Object.keys(sm.json) : null };
  if (sm.json) {
    const j = sm.json;
    await save(`${slug}-summary-sample.json`, {
      keyEvents: (j.keyEvents || []).slice(0, 30),
      goalCommentary: (j.commentary || []).filter(c => /goal|assist/i.test(JSON.stringify(c))).slice(0, 12),
      headerDetails: j.header?.competitions?.[0]?.details?.slice?.(0, 15) ?? null
    });
  }
}
await save("summary.json", { at: new Date().toISOString(), log });
console.log(JSON.stringify(log, null, 1));
