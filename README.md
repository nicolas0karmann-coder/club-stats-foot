# Top buteurs & passeurs par club

Page statique (GitHub Pages) alimentée par un workflow GitHub Actions qui interroge
[football-data.org](https://www.football-data.org) toutes les 3 heures.

- `scripts/update.mjs` : collecte et écrit `data/*.json`
- `.github/workflows/update.yml` : planification (secret `FOOTBALL_API_KEY` requis)
- `index.html` : la page (lit `data/`)

Championnats football-data.org : variable `LEAGUES` du script (par défaut tous les championnats du plan gratuit : `FL1,PL,PD,SA,BL1,DED,PPL,ELC,CL,BSA`).

Le plan gratuit de football-data.org ne donne pas le détail des buts (dernier but/passe, buteurs par match) : `FETCH_DETAILS=1` les active avec un plan qui les inclut.
