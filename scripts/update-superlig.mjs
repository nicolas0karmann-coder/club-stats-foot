// Süper Lig via API-Football (api-sports.io, formule gratuite : 100 requêtes/jour).
// Tout est calculé à partir des événements de chaque match (buts + passeurs), mis en cache.
// Écrit data/SL.json et data/status-SL.json (diagnostic lisible).
import fs from "node:fs/promises";
import path from "node:path";

const KEY = process.env.APIFOOTBALL_KEY;
const BASE = process.env.AF_BASE || "https://v3.football.api-sports.io";
const LEAGUE_ID = process.env.AF_LEAGUE_ID || "203";
const DATA = process.env.DATA_DIR || "data";
const GAP = +(process.env.GAP_MS ?? 6500);
const MAX_CALLS = +(process.env.MAX_CALLS || 90);   // appels « événements » max par exécution
const RESERVE = +(process.env.RESERVE || 3);        // on garde quelques requêtes en réserve
const PAUSE_RATE = +(process.env.PAUSE_RATE_MS ?? 62000);
const CODE = "SL", NAME = "Süper Lig (Turquie)";

const now = new Date();
const SEASON = +(process.env.AF_SEASON || (now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function readJson(f, d) { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return d; } }
async function writeJson(f, v) { await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, JSON.stringify(v)); }
async function status(ok, message, extra = {}) {
  await writeJson(`${DATA}/status-${CODE}.json`, { ok, message, at: new Date().toISOString(), season: SEASON, ...extra });
  console.log(`${CODE} : ${ok ? "OK" : "KO"} — ${message}`);
}

if (!KEY) { console.log("APIFOOTBALL_KEY absente : Süper Lig ignorée."); process.exit(0); }

let lastCall = 0, remaining = Infinity;
async function api(p) {
  for (let a = 0; a < 3; a++) {
    const wait = GAP - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const r = await fetch(BASE + p, { headers: { "x-apisports-key": KEY } });
    const rem = r.headers.get("x-ratelimit-requests-remaining");
    if (rem !== null && rem !== "") remaining = +rem;
    if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { kind: "http" });
    const j = await r.json();
    const errs = Array.isArray(j.errors) ? {} : (j.errors || {});
    if (errs.rateLimit) { console.log("limite par minute : pause"); await sleep(PAUSE_RATE); continue; }
    if (errs.requests) throw Object.assign(new Error(String(errs.requests)), { kind: "quota" });
    const msg = Object.entries(errs).map(([k, v]) => `${k}: ${v}`).join(" ; ");
    if (msg) throw Object.assign(new Error(msg), { kind: "api" });
    return j;
  }
  throw Object.assign(new Error("Limite par minute persistante"), { kind: "quota" });
}

const mmss = (e, x) => e + (x || 0) / 100;
function sideInfo(m) { return { date: m.date, home: m.home, away: m.away, homeId: m.homeId, awayId: m.awayId, hs: m.hs, as: m.as }; }

async function main() {
  const cacheFile = `${DATA}/cache/${CODE}.json`;
  const old = await readJson(cacheFile, null);
  const cache = old && old.v === 2 ? old : { v: 2, fixtures: {} };   // v2 : garde aussi les csc

  const fx = await api(`/fixtures?league=${LEAGUE_ID}&season=${SEASON}&status=FT-AET-PEN`);
  const finished = (fx.response || []).map(f => ({
    id: f.fixture.id, date: f.fixture.date,
    homeId: f.teams.home.id, awayId: f.teams.away.id,
    home: f.teams.home.name, away: f.teams.away.name,
    homeLogo: f.teams.home.logo, awayLogo: f.teams.away.logo,
    hs: f.goals.home, as: f.goals.away
  })).sort((a, b) => b.date.localeCompare(a.date));
  if (!finished.length) return status(false, `Aucun match terminé renvoyé pour la saison ${SEASON} (accès gratuit limité à d'autres saisons ?)`);

  let calls = 0, stoppedQuota = false;
  for (const m of finished) {
    if (cache.fixtures[m.id]) continue;
    if (calls >= MAX_CALLS || remaining <= RESERVE) { stoppedQuota = true; break; }
    calls++;
    const ev = await api(`/fixtures/events?fixture=${m.id}`);
    cache.fixtures[m.id] = (ev.response || [])
      .filter(e => e.type === "Goal" && (e.detail === "Normal Goal" || e.detail === "Penalty" || e.detail === "Own Goal") && e.player && e.player.id)
      .map(e => ({ teamId: e.team.id, minute: e.time.elapsed, extra: e.time.extra || null, pen: e.detail === "Penalty", own: e.detail === "Own Goal",
                   scorerId: e.player.id, scorer: e.player.name, assistId: e.assist?.id ?? null, assist: e.assist?.name ?? null }));
  }
  await writeJson(cacheFile, cache);

  // totaux par joueur, du plus ancien au plus récent (le dernier écrase)
  const players = new Map();
  const get = (teamId, id, name) => {
    const k = teamId + ":" + id;
    if (!players.has(k)) players.set(k, { id, name, teamId, goals: 0, assists: 0, pens: 0, lastGoal: null, lastAssist: null });
    return players.get(k);
  };
  let done = 0;
  for (const m of finished.slice().reverse()) {
    const evs = cache.fixtures[m.id]; if (!evs) continue;
    done++;
    for (const e of evs.slice().sort((a, b) => mmss(a.minute, a.extra) - mmss(b.minute, b.extra))) {
      if (e.own) continue;   // un csc n'est ni un but ni une passe pour le joueur
      const s = get(e.teamId, e.scorerId, e.scorer);
      s.goals++; if (e.pen) s.pens++;
      s.lastGoal = { ...sideInfo(m), minute: e.minute, inj: e.extra };
      if (e.assistId) {
        const a = get(e.teamId, e.assistId, e.assist);
        a.assists++;
        a.lastAssist = { ...sideInfo(m), minute: e.minute, inj: e.extra };
      }
    }
  }

  const teams = new Map();
  for (const m of finished) {
    if (!teams.has(m.homeId)) teams.set(m.homeId, { id: m.homeId, name: m.home, short: m.home, crest: m.homeLogo || null });
    if (!teams.has(m.awayId)) teams.set(m.awayId, { id: m.awayId, name: m.away, short: m.away, crest: m.awayLogo || null });
  }
  const byTeam = new Map([...teams.keys()].map(id => [id, []]));
  for (const p of players.values()) if (byTeam.has(p.teamId)) byTeam.get(p.teamId).push(p);
  const top = (arr, f, other, n = 3) => arr.filter(p => p[f] > 0)
    .sort((a, b) => (b[f] - a[f]) || (b[other] - a[other]) || a.name.localeCompare(b.name)).slice(0, n);
  const out = [...teams.values()].sort((a, b) => a.name.localeCompare(b.name)).map(t => {
    const ps = byTeam.get(t.id);
    const recent = finished.filter(m => m.homeId === t.id || m.awayId === t.id).slice(0, 5).map(m => ({
      ...sideInfo(m),
      goals: cache.fixtures[m.id]
        ? cache.fixtures[m.id].slice().sort((a, b) => mmss(a.minute, a.extra) - mmss(b.minute, b.extra))
            .map(e => ({ minute: e.minute, inj: e.extra, scorer: e.scorer, assist: e.assist, kind: e.own ? "O" : e.pen ? "P" : null }))
        : null
    }));
    return {
      ...t, recent,
      goals: top(ps, "goals", "assists").map(p => ({ id: p.id, name: p.name, goals: p.goals, assists: p.assists, played: null, pens: p.pens, last: p.lastGoal })),
      assists: top(ps, "assists", "goals").map(p => ({ id: p.id, name: p.name, goals: p.goals, assists: p.assists, played: null, pens: p.pens, last: p.lastAssist }))
    };
  });
  const missing = finished.length - done;
  await writeJson(`${DATA}/${CODE}.json`, {
    code: CODE, name: NAME, season: `${SEASON}/${String((SEASON + 1) % 100).padStart(2, "0")}`,
    updated: new Date().toISOString(), pending: 0, provisional: missing > 0, done, total: finished.length, teams: out
  });
  await status(true, `${done}/${finished.length} matchs détaillés (${calls} appels)${stoppedQuota ? " — quota du jour atteint, suite au prochain passage" : ""}`, { done, total: finished.length, remaining: Number.isFinite(remaining) ? remaining : null });
}

try { await main(); }
catch (e) {
  if (e.kind === "quota") await status(false, "Quota API atteint, reprise au prochain passage : " + e.message);
  else await status(false, "Erreur : " + e.message);
}
// ne fait jamais échouer le workflow : le diagnostic est dans data/status-SL.json
