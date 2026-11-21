# Top buteurs & passeurs par club

Page statique (GitHub Pages) alimentée par un workflow GitHub Actions qui interroge
[football-data.org](https://www.football-data.org) toutes les 3 heures.

- `scripts/update.mjs` : collecte et écrit `data/*.json`
- `.github/workflows/update.yml` : planification (secret `FOOTBALL_API_KEY` requis)
- `index.html` : la page (lit `data/`)

Championnats : variable `LEAGUES` du script (par défaut `FL1,PL,PD,SA,BL1` ; aussi `DED,PPL,ELC`).
