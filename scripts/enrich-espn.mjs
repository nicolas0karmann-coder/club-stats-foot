// Enrichit les données avec ESPN (API non officielle, sans clé) :
//  - buteurs + passeurs des 5 derniers matchs de chaque club
//  - date/match du dernier but ou de la dernière passe des joueurs du top 3
//  - Süper Lig complète (calculée depuis ESPN seul : buteurs, mais passeurs rarement fournis)
// ESPN n'accepte qu'un jour par requête : on parcourt les jours, du plus récent au plus ancien,
// avec un cache (data/cache/espn-*.json) pour ne refaire que le nécessaire. Reprend là où il s'est arrêté.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.ESPN_BASE || "https://site.api.espn.com/apis/site/v2/sports/soccer";
const DATA = process.env.DATA_DIR || "data";
const GAP = +(process.env.GAP_MS ?? 700);
const WINDOW_DAYS = +(process.env.WINDOW_DAYS || 70);
const CALLS_PER_LEAGUE = +(process.env.CALLS_PER_LEAGUE || 150);
const MAX_MS = +(process.env.MAX_MS || 40 * 60 * 1000);

const SLUGS = { FL1: "fra.1", PL: "eng.1", PD: "esp.1", SA: "ita.1", BL1: "ger.1", DED: "ned.1", PPL: "por.1", ELC: "eng.2", CL: "uefa.champions", BSA: "bra.1" };
const SL = { code: "SL", slug: "tur.1", name: "Süper Lig (Turquie)" };

// ---------- utilitaires
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function readJson(f, d) { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return d; } }
async function writeJson(f, v) { await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, JSON.stringify(v)); }
const todayUTC = () => process.env.TODAY ? new Date(process.env.TODAY + "T12:00:00Z") : new Date();
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");
const dash = d => d.toISOString().slice(0, 10);

// ---------- rapprochement des noms (FD ↔ ESPN)
const STOP = new Set(["fc", "cf", "sc", "ac", "as", "afc", "fk", "sk", "sv", "vfb", "vfl", "tsg", "rc", "ssc", "us", "ud", "cd", "sd", "ca", "rcd", "club", "de", "the", "calcio", "bk", "if", "ik", "fsv", "sad", "1", "04", "05", "09", "1899", "1900"]);
export function norm(s) { return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
const tokens = s => norm(s).split(" ").filter(Boolean);
const tokEq = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
export function teamScore(a, b) {
  const A = tokens(a).filter(t => !STOP.has(t)), B = tokens(b).filter(t => !STOP.has(t));
  if (!A.length || !B.length) return 0;
  let m = 0; for (const x of A) if (B.some(y => tokEq(x, y))) m++;
  return m / Math.max(A.length, B.length);
}
export function nameMatch(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return false;
  const [s, l] = A.length <= B.length ? [A, B] : [B, A];
  return s.every(x => l.some(y => tokEq(x, y)));
}

// ---------- ESPN
let lastCall = 0;
async function get(url) {
  for (let a = 0; a < 3; a++) {
    const w = GAP - (Date.now() - lastCall); if (w > 0) await sleep(w); lastCall = Date.now();
    try {
      const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (club-stats)" } });
      if (r.status === 429 || r.status >= 500) { await sleep(2000 * (a + 1)); continue; }
      if (!r.ok) return { status: r.status, json: null };
      return { status: 200, json: await r.json() };
    } catch { await sleep(1000 * (a + 1)); }
  }
  return { status: 0, json: null };
}
export function parseEvents(json) {
  return (json?.events || []).filter(e => e.status?.type?.completed).map(e => {
    const c = e.competitions?.[0];
    const h = c?.competitors?.find(x => x.homeAway === "home"), a = c?.competitors?.find(x => x.homeAway === "away");
    if (!h || !a) return null;
    return { id: String(e.id), date: new Date(e.date).toISOString(),
             home: h.team.displayName, homeId: String(h.team.id), homeLogo: h.team.logo || null,
             away: a.team.displayName, awayId: String(a.team.id), awayLogo: a.team.logo || null,
             hs: +h.score, as: +a.score };
  }).filter(Boolean);
}
export function parseGoals(j) {
  const out = [];
  for (const e of j?.keyEvents || []) {
    if (!e.scoringPlay || e.shootout) continue;
    const t = e.type?.text || "", p = e.participants || [], own = /own/i.test(t);
    const m = String(e.clock?.displayValue || "").match(/(\d+)'?(?:\s*\+\s*(\d+))?/);
    out.push({ minute: m ? +m[1] : null, inj: m && m[2] ? +m[2] : null, teamId: e.team?.id ? String(e.team.id) : null,
               scorer: p[0]?.athlete?.displayName || null, assist: own ? null : (p[1]?.athlete?.displayName || null),
               kind: own ? "O" : /penalty/i.test(t) ? "P" : null });
  }
  return out;
}

// parcourt les jours (récent → ancien) ; un jour n'est « final » (jamais refait) que s'il est assez ancien
export async function collect(slug, cache, from, today, budget, deadline) {
  let calls = 0, complete = true; const errors = [];
  for (let d = today; d >= from; d = addDays(d, -1)) {
    const key = ymd(d), final = d <= addDays(today, -2);
    if (final && cache.days[key]) continue;
    if (calls >= budget || Date.now() > deadline) { complete = false; break; }
    calls++;
    const r = await get(`${BASE}/${slug}/scoreboard?dates=${key}`);
    if (r.status !== 200) { errors.push(`${key}: HTTP ${r.status}`); complete = false; if (errors.length >= 5) break; continue; }
    let dayOk = true;
    for (const ev of parseEvents(r.json)) {
      if (cache.matches[ev.id]?.goals) continue;
      if (calls >= budget || Date.now() > deadline) { dayOk = false; complete = false; continue; }
      calls++;
      const s = await get(`${BASE}/${slug}/summary?event=${ev.id}`);
      if (s.status !== 200) { errors.push(`match ${ev.id}: HTTP ${s.status}`); dayOk = false; complete = false; continue; }
      cache.matches[ev.id] = { ...ev, goals: parseGoals(s.json) };
    }
    if (final && dayOk) cache.days[key] = 1;
  }
  return { calls, complete, errors };
}

// ---------- enrichissement des championnats football-data.org
const byMinute = (a, b) => (a.minute + (a.inj || 0) / 100) - (b.minute + (b.inj || 0) / 100);
const outGoal = g => ({ minute: g.minute, inj: g.inj, scorer: g.scorer, assist: g.assist, kind: g.kind });
// buts d'un match avec l'équipe créditée : "H" (domicile) ou "A" (extérieur).
// Pour un csc, on déduit le camp du score (buts du match non expliqués par les autres buts).
export function outGoals(m) {
  const gs = m.goals.slice().sort(byMinute);
  const sideOf = g => g.kind === "O" ? null : g.teamId === m.homeId ? "H" : g.teamId === m.awayId ? "A" : null;
  let nh = 0, na = 0, unknown = false;
  for (const g of gs) { if (g.kind === "O") continue; const s = sideOf(g); if (s === "H") nh++; else if (s === "A") na++; else unknown = true; }
  let dh = (m.hs ?? 0) - nh, da = (m.as ?? 0) - na;
  return gs.map(g => {
    let side = sideOf(g);
    if (g.kind === "O") {
      if (!unknown && dh > 0 && da <= 0) { side = "H"; dh--; }
      else if (!unknown && da > 0 && dh <= 0) { side = "A"; da--; }
    }
    return { ...outGoal(g), side };
  });
}
export function enrichLeague(lj, cache) {
  const espnTeams = new Map();
  const matches = Object.values(cache.matches).sort((a, b) => b.date.localeCompare(a.date));
  for (const m of matches) { espnTeams.set(m.homeId, m.home); espnTeams.set(m.awayId, m.away); }
  // association club football-data.org ↔ équipe ESPN : meilleures paires d'abord, chaque équipe une seule fois
  const pairs = [];
  for (const t of lj.teams) for (const [id, name] of espnTeams) {
    const sc = Math.max(teamScore(t.name, name), teamScore(t.short, name));
    if (sc >= 0.5) pairs.push({ fd: t.id, espn: id, sc });
  }
  pairs.sort((a, b) => b.sc - a.sc);
  const map = new Map(), usedEspn = new Set();
  for (const p of pairs) if (!map.has(p.fd) && !usedEspn.has(p.espn)) { map.set(p.fd, p.espn); usedEspn.add(p.espn); }
  const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
  for (const t of lj.teams) {
    const eid = map.get(t.id);
    for (const r of t.recent || []) {
      const he = map.get(r.homeId), ae = map.get(r.awayId);
      const m = he && ae && matches.find(x => x.homeId === he && x.awayId === ae && dayDiff(x.date, r.date) <= 1.5 &&
                                              (r.hs == null || x.hs === r.hs) && (r.as == null || x.as === r.as));
      r.goals = m ? outGoals(m) : null;
    }
    for (const kind of ["goals", "assists"]) for (const p of t[kind]) {
      p.last = null; if (!eid) continue;
      for (const m of matches) {
        const hits = m.goals.filter(g => g.kind !== "O" && (g.teamId === eid || g.teamId === null) && nameMatch(kind === "goals" ? g.scorer : g.assist, p.name));
        if (hits.length) {
          const g = hits.reduce((a, b) => byMinute(a, b) >= 0 ? a : b);
          p.last = { date: m.date, home: m.home, away: m.away, homeId: m.homeId === eid ? t.id : 0, awayId: m.awayId === eid ? t.id : 0,
                     hs: m.hs, as: m.as, minute: g.minute, inj: g.inj };
          break;
        }
      }
    }
  }
}

// ---------- Süper Lig : tout depuis ESPN
export function buildSL(cache, from, complete, season) {
  const ms = Object.values(cache.matches).sort((a, b) => a.date.localeCompare(b.date));
  const players = new Map(), teams = new Map();
  const pl = (tid, name) => { const k = tid + ":" + name; if (!players.has(k)) players.set(k, { id: k, name, teamId: tid, goals: 0, assists: 0, pens: 0, lastGoal: null, lastAssist: null }); return players.get(k); };
  let totalAssists = 0;
  for (const m of ms) {
    teams.set(m.homeId, { id: +m.homeId, name: m.home, short: m.home, crest: m.homeLogo });
    teams.set(m.awayId, { id: +m.awayId, name: m.away, short: m.away, crest: m.awayLogo });
    for (const g of m.goals.slice().sort(byMinute)) {
      if (g.kind === "O" || !g.scorer || !g.teamId) continue;
      const info = { date: m.date, home: m.home, away: m.away, homeId: +m.homeId, awayId: +m.awayId, hs: m.hs, as: m.as, minute: g.minute, inj: g.inj };
      const s = pl(g.teamId, g.scorer); s.goals++; if (g.kind === "P") s.pens++; s.lastGoal = info;
      if (g.assist) { const a = pl(g.teamId, g.assist); a.assists++; a.lastAssist = info; totalAssists++; }
    }
  }
  const by = new Map([...teams.keys()].map(id => [id, []]));
  for (const p of players.values()) if (by.has(p.teamId)) by.get(p.teamId).push(p);
  const top = (arr, f, o) => arr.filter(p => p[f] > 0).sort((a, b) => (b[f] - a[f]) || (b[o] - a[o]) || a.name.localeCompare(b.name)).slice(0, 3);
  const desc = ms.slice().reverse();
  const list = [...teams.values()].sort((a, b) => a.name.localeCompare(b.name)).map(t => ({
    ...t,
    recent: desc.filter(m => +m.homeId === t.id || +m.awayId === t.id).slice(0, 5).map(m => ({
      date: m.date, homeId: +m.homeId, awayId: +m.awayId, home: m.home, away: m.away, hs: m.hs, as: m.as, goals: outGoals(m) })),
    goals: top(by.get(String(t.id)), "goals", "assists").map(p => ({ id: p.id, name: p.name, goals: p.goals, assists: p.assists, played: null, pens: p.pens, last: p.lastGoal })),
    assists: top(by.get(String(t.id)), "assists", "goals").map(p => ({ id: p.id, name: p.name, goals: p.goals, assists: p.assists, played: null, pens: p.pens, last: p.lastAssist }))
  }));
  return { code: SL.code, name: SL.name, season, updated: new Date().toISOString(), pending: complete ? 0 : 1, provisional: !complete,
           espn: { from: dash(from), complete }, noAssists: totalAssists === 0, teams: list };
}

// ---------- programme principal
export async function main() {
  const today = todayUTC(), deadline = Date.now() + MAX_MS;
  const status = { at: new Date().toISOString(), leagues: {} };
  const codes = (process.env.ESPN_LEAGUES || [...Object.keys(SLUGS), "SL"].join(",")).split(",").map(s => s.trim()).filter(Boolean);
  for (const code of codes) {
    const slug = code === "SL" ? SL.slug : SLUGS[code]; if (!slug) continue;
    const cacheFile = `${DATA}/cache/espn-${code}.json`;
    const cache = await readJson(cacheFile, { days: {}, matches: {} });
    const y = today.getUTCMonth() >= 6 ? today.getUTCFullYear() : today.getUTCFullYear() - 1;
    const from = code === "SL" ? new Date(Date.UTC(y, 7, 1, 12)) : addDays(today, -WINDOW_DAYS);
    const res = await collect(slug, cache, from, today, code === "SL" ? CALLS_PER_LEAGUE + 60 : CALLS_PER_LEAGUE, deadline);
    await writeJson(cacheFile, cache);
    status.leagues[code] = { slug, calls: res.calls, matches: Object.keys(cache.matches).length, complete: res.complete, errors: res.errors };
    console.log(`${code} (${slug}) : ${res.calls} appels, ${Object.keys(cache.matches).length} matchs, ${res.complete ? "complet" : "partiel"}${res.errors.length ? " — " + res.errors[0] : ""}`);
    if (code === "SL") {
      if (Object.keys(cache.matches).length) await writeJson(`${DATA}/SL.json`, buildSL(cache, from, res.complete, `${y}/${String((y + 1) % 100).padStart(2, "0")}`));
    } else {
      const lj = await readJson(`${DATA}/${code}.json`, null);
      if (lj) { enrichLeague(lj, cache); lj.espn = { from: dash(from), complete: res.complete }; lj.pending = res.complete ? 0 : 1; await writeJson(`${DATA}/${code}.json`, lj); }
    }
  }
  // index : ajoute la Süper Lig et resynchronise les indicateurs
  const idx = await readJson(`${DATA}/index.json`, { updated: null, leagues: [] });
  const sl = await readJson(`${DATA}/SL.json`, null);
  if (sl && !idx.leagues.some(l => l.code === "SL")) idx.leagues.push({ code: "SL", name: sl.name });
  for (const l of idx.leagues) {
    const j = await readJson(`${DATA}/${l.code}.json`, null);
    if (j) Object.assign(l, { name: j.name, season: j.season, updated: j.updated, pending: j.pending, provisional: !!j.provisional });
  }
  idx.updated = new Date().toISOString();
  await writeJson(`${DATA}/index.json`, idx);
  await writeJson(`${DATA}/status-espn.json`, status);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error("Erreur ESPN :", e.message); process.exit(0); });
}
