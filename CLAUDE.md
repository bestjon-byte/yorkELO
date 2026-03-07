# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

York Tennis ELO Rating System — a cross-divisional ELO rating system for the York Men's Tennis League (and eventually the York & District Mixed Tennis League). Scrapes historical match data, computes ELO ratings for every player, and presents them via a web UI.

## Tech Stack

- **Runtime:** Node.js (CommonJS) + Cheerio for scraping
- **Data:** JSON flat files (`fixtures_YYYY.json`, `ratings_all.json`)
- **UI:** Vanilla JS single-page app served by `server.js` (built-in `http` module, no framework)

## Key Commands

```bash
node scraper.js                  # scrape 2025 season → fixtures_2025.json
node scraper-archive.js [year]   # scrape one or all archive seasons (2018,2019,2021–2024)
node dedupe-auto.js              # apply all confirmed bulk alias decisions
node dedupe.js [--report]        # interactive / report-only dedupe review
node elo.js                      # full multi-season ELO → ratings_all.json
node server.js                   # web UI at http://localhost:3000
```

## ELO Algorithm

- **Unit of play:** Doubles rubber (pair vs pair). Team rating = average of two individual player ratings. Both players receive the same adjustment.
- **Formula:** Standard ELO — `E = 1 / (1 + 10^((opponentRating - playerRating) / 400))`, `change = K * (actual - expected)`
- **Initial rating:** Division-seeded (D1=1600, D2=1470, D3=1350, D4=1230, D5=1110, D6=1040, D7=970, D8=900) | **K:** 32 | **Floor:** 500 | **Ceiling:** 3000
- **No season resets** — ratings carry over continuously across seasons.
- **Sequential processing:** Rubbers within a fixture are processed in `rubber_order` sequence. Each rubber updates ratings before the next is calculated.
- **Draws (6-6):** `actualScore = 0.5` for both pairs.
- **Conceded fixtures:** Detected by "Match conceded by" text — skipped entirely, no ELO impact.
- **Cross-fixture ordering is critical:** All fixtures sorted by date before processing.

## Scraper: York Men's League

- **Source:** yorkmenstennisleague.co.uk — public HTML
- **Seasons:** 2018, 2019, 2021–2025 (no 2020 — COVID)
- **Format:** 8 divisions, 3 pairs per team, 9 rubbers per fixture
- **2025 URLs:** `/divisions/{n}/Division_{n}` (fixture list), `/fixtures/{id}` (scorecard)
- **Archive URLs:** `/archive/{year}/divisions.php?id={n}`, `/archive/{year}/result.php?id={id}`
- **Archive fixture IDs** are strings like `"2021042"` — keep as strings, not integers
- **Scorecard:** Matrix table — home pairs = rows, away pairs = columns. Score format `homeGames-awayGames`.

## Deduplication Workflow

- `player-aliases.json` — variant→canonical name map (120 entries)
- `player-not-dupes.json` — confirmed different-person pairs (17 entries, never shown again)
- `dedupe-auto.js` — idempotent; re-run after editing CONFIRMED_ALIASES/CONFIRMED_NOT_DUPES
- ⚠️ Running `node dedupe.js` interactively writes to `player-aliases.json` immediately. It will NOT overwrite existing keys — so run `dedupe-auto.js` first, then interactive review.
- After any alias changes: re-run `node elo.js` then restart `node server.js`
- Phase 1 (same team, d≤2) catches typos. Phase 2 (cross-team, d≤1) catches club moves — shows year overlap to help distinguish same person vs different people.

## Build Phases

1. **Phase 1a–c:** DONE — All 7 seasons scraped, ELO calculated, web UI live
   - 2456 fixtures, 22,104 rubbers, 1830 players rated
   - 2021 is genuinely short (150 fixtures) — COVID-shortened season, data is correct
   - Fixture IDs in 2021 data start with "2020" — correct, just the league's internal numbering
2. **Phase 1d:** TODO — live scrape trigger for new 2025 results mid-season
3. **Phase 2:** TODO — Mixed League (MyDivision.com), unified cross-league ELO

## Known Issues & Open Questions

- **13 dedupe candidates outstanding** — run `node dedupe.js` to review (mostly possible brothers with same surname at same club — `Max/Zak Los`, `Sam/Tom Hitchenor` etc.)
- **`url.parse()` deprecation warning** in `server.js` — harmless, can switch to WHATWG URL API if desired
