// Collecte les stats football-data.org et écrit des fichiers JSON statiques dans data/.
// Tourne dans GitHub Actions (clé API dans le secret FOOTBALL_API_KEY).
import fs from "node:fs/promises";
import path from "node:path";

const KEY = process.env.FOOTBALL_API_KEY;
const BASE = process.env.FD_BASE || "https://api.football-data.org/v4";
const LEAGUES = (process.env.LEAGUES || "FL1,PL,PD,SA,BL1,DED,PPL,ELC,CL,BSA").split(",").map(s => s.trim()).filter(Boolean);
// Le plan gratuit de football-data.org ne fournit pas le détail des buts : désactivé par défaut.
// Mettre FETCH_DETAILS=1 avec un abonnement qui les inclut pour activer dernier but/passe et buteurs des matchs.
const DETAILS = process.env.FETCH_DETAILS === "1";
const BUDGET = +(process.env.CALLS_PER_LEAGUE || 80);
const RECENT_BUDGET = +(process.env.RECENT_CALLS_PER_LEAGUE || 60);   // détails des matchs récents (buteurs affichés)   // détails de matchs max par championnat et par exécution
const GAP = +(process.env.GAP_MS ?? 6500);              // quota gratuit : 10 appels / minute
const PAUSE_429 = +(process.env.PAUSE_429_MS ?? 65000);
const DATA = process.env.DATA_DIR || "data";
const NAMES = {
  PL: "Premier League (Angleterre)", PD: "LaLiga (Espagne)", SA: "Serie A (Italie)",
  BL1: "Bundesliga (Allemagne)", FL1: "Ligue 1 (France)", DED: "Eredivisie (Pays-Bas)",
  PPL: "Primeira Liga (Portugal)", ELC: "Championship (Angleterre D2)",
  CL: "Ligue des champions", BSA: "Brasileirão (Brésil)"
};

if (!KEY) { console.error("FOOTBALL_API_KEY manquante (Settings → Secrets → Actions)."); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastCall = 0;
async function api(p) {
  for (let a = 0; a < 4; a++) {
    const wait = GAP - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const r = await fetch(BASE + p, { headers: { "X-Auth-Token": KEY } });
    if (r.status === 429) { console.log("429 : pause"); await sleep(PAUSE_429); continue; }
    if (r.status === 401 || r.status === 400) { const e = new Error("Clé API invalide (" + r.status + ")"); e.fatal = true; throw e; }
    if (r.status === 403 || r.status === 404) { const e = new Error(`HTTP ${r.status} sur ${p} (non inclus dans l'abonnement ?)`); e.skip = true; throw e; }
    if (!r.ok) throw new Error(`HTTP ${r.status} sur ${p}`);
    return r.json();
  }
  throw new Error("Trop de 429 sur " + p);
}

async function readJson(f, dflt) { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return dflt; } }
async function writeJson(f, v) { await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, JSON.stringify(v)); }

// ---- logique pure
function topN(rows, field, n = 3) {
  const other = field === "goals" ? "assists" : "goals";
  return rows.filter(r => (r[field] || 0) > 0)
    .sort((a, b) => (b[field] - a[field]) || ((a.playedMatches || 0) - (b.playedMatches || 0)) || ((b[other] || 0) - (a[other] || 0)))
    .slice(0, n);
}
function slimMatch(m) {
  return {
    v: 2, id: m.id, date: m.utcDate,
    homeId: m.homeTeam.id, awayId: m.awayTeam.id,
    home: m.homeTeam.shortName || m.homeTeam.name, away: m.awayTeam.shortName || m.awayTeam.name,
    hs: m.score?.fullTime?.home ?? null, as: m.score?.fullTime?.away ?? null,
    goals: (m.goals || []).map(g => ({
      minute: g.minute, inj: g.injuryTime || null, type: g.type, team: g.team?.id ?? null,
      scorerId: g.scorer?.id ?? null, assistId: g.assist?.id ?? null,
      scorer: g.scorer?.name ?? null, assist: g.assist?.name ?? null
    }))
  };
}
function eventIn(match, pid, kind) {
  const hits = match.goals.filter(g => kind === "goals" ? (g.scorerId === pid && g.type !== "OWN") : g.assistId === pid);
  if (!hits.length) return null;
  const last = hits.reduce((a, b) => (b.minute + (b.inj || 0) / 100 > a.minute + (a.inj || 0) / 100 ? b : a));
  return { date: match.date, home: match.home, away: match.away, homeId: match.homeId, awayId: match.awayId,
           hs: match.hs, as: match.as, minute: last.minute, inj: last.inj };
}

async function doLeague(code) {
  const cacheFile = `${DATA}/cache/${code}.json`;
  const cache = await readJson(cacheFile, { matches: {} });
  const sc = await api(`/competitions/${code}/scorers?limit=500`);
  const ml = await api(`/competitions/${code}/matches?status=FINISHED`);
  const finished = ml.matches.filter(m => m.status === "FINISHED").sort((a, b) => b.utcDate.localeCompare(a.utcDate));

  // clubs (depuis les matchs : évite un appel supplémentaire)
  const teams = new Map();
  for (const m of finished) for (const t of [m.homeTeam, m.awayTeam]) if (!teams.has(t.id)) teams.set(t.id, { id: t.id, name: t.name, short: t.shortName || t.name, crest: t.crest || null });

  const out = new Map();
  const wanted = [];
  for (const [id, t] of teams) {
    const rows = sc.scorers.filter(s => s.team?.id === id);
    const mk = (r, kind) => ({ id: r.player.id, name: r.player.name, goals: r.goals || 0, assists: r.assists || 0,
                               played: r.playedMatches ?? null, pens: r.penalties || 0, last: null, _kind: kind });
    const g = topN(rows, "goals").map(r => mk(r, "goals"));
    const a = topN(rows, "assists").map(r => mk(r, "assists"));
    const recent = finished.filter(m => m.homeTeam.id === id || m.awayTeam.id === id).slice(0, 5).map(m => ({
      id: m.id, date: m.utcDate, homeId: m.homeTeam.id, awayId: m.awayTeam.id,
      home: m.homeTeam.shortName || m.homeTeam.name, away: m.awayTeam.shortName || m.awayTeam.name,
      hs: m.score?.fullTime?.home ?? null, as: m.score?.fullTime?.away ?? null }));
    out.set(id, { ...t, goals: g, assists: a, recent });
    [...g, ...a].forEach(p => wanted.push(p));
  }

  // dernier but / dernière passe : du match le plus récent au plus ancien
  let pending = wanted.slice(), calls = 0, incomplete = false;
  for (const m of (DETAILS ? finished : [])) {
    if (!pending.length) break;
    let d = cache.matches[m.id];
    if (!d) {
      if (calls >= BUDGET) { incomplete = true; break; }
      calls++;
      d = slimMatch(await api(`/matches/${m.id}`));
      cache.matches[m.id] = d;
    }
    pending = pending.filter(p => { const ev = eventIn(d, p.id, p._kind); if (ev) { p.last = ev; return false; } return true; });
  }
  // buteurs et passeurs des matchs récents (affichés sous chaque résultat)
  let rcalls = 0;
  const needed = new Set();
  for (const t of out.values()) for (const r of t.recent) needed.add(r.id);
  for (const id of (DETAILS ? needed : [])) {
    if (cache.matches[id]?.v === 2) continue;
    if (rcalls >= RECENT_BUDGET) break;
    rcalls++;
    cache.matches[id] = slimMatch(await api(`/matches/${id}`));
  }
  for (const t of out.values()) for (const r of t.recent) {
    const c = cache.matches[r.id];
    r.goals = c?.v === 2
      ? c.goals.slice().sort((a, b) => (a.minute + (a.inj || 0) / 100) - (b.minute + (b.inj || 0) / 100))
          .map(g => ({ minute: g.minute, inj: g.inj, scorer: g.scorer, assist: g.assist, kind: g.type === "OWN" ? "O" : g.type === "PENALTY" ? "P" : null }))
      : null;
    delete r.id;
  }
  await writeJson(cacheFile, cache);

  const season = sc.season?.startDate ? `${sc.season.startDate.slice(0, 4)}/${String(+sc.season.startDate.slice(0, 4) + 1).slice(2)}` : (sc.filters?.season || "");
  const teamList = [...out.values()].sort((a, b) => a.name.localeCompare(b.name)).map(t => {
    const clean = p => { const { _kind, ...r } = p; return r; };
    return { ...t, goals: t.goals.map(clean), assists: t.assists.map(clean) };
  });
  await writeJson(`${DATA}/${code}.json`, {
    code, name: NAMES[code] || code, season, seasonStart: sc.season?.startDate || null,
    assistsTotal: sc.scorers.reduce((n, r) => n + (r.assists || 0), 0), updated: new Date().toISOString(),
    pending: incomplete ? pending.length : 0, teams: teamList
  });
  console.log(`${code} : ${teamList.length} clubs, ${calls + rcalls} détails récupérés, ${incomplete ? pending.length + " en attente" : "complet"}`);
}

let ok = 0;
for (const code of LEAGUES) {
  try { await doLeague(code); ok++; }
  catch (e) { console.error(code, "→", e.message); if (e.fatal) break; }
}
const leagues = [];
for (const code of [...LEAGUES, "SL"]) {   // SL = Süper Lig (scripts/enrich-espn.mjs)
  const j = await readJson(`${DATA}/${code}.json`, null);
  if (j) leagues.push({ code, name: j.name, season: j.season, updated: j.updated, pending: j.pending, provisional: !!j.provisional });
}
await writeJson(`${DATA}/index.json`, { updated: new Date().toISOString(), leagues });
if (!ok) { console.error("Aucun championnat mis à jour."); process.exit(1); }
