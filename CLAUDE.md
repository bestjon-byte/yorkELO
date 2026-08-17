# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

York Tennis ELO Rating System — a cross-divisional ELO rating system for the York Men's Tennis League (and eventually the York & District Mixed Tennis League). Scrapes historical match data, computes ELO ratings for every player, and presents them via a web UI.

## Tech Stack

- **Runtime:** Node.js (CommonJS) + Cheerio for scraping
- **Data:** JSON flat files (`fixtures_YYYY.json`, `ratings_all.json`)
- **UI:** Vanilla JS single-page app served by `server.js` (built-in `http` module, no framework)
- **Deployment:** Vercel (serverless functions in `api/`) + Supabase PostgreSQL (tables prefixed `york_` or `mixed_`)

## Key Commands

```bash
node scraper.js                  # scrape 2026 season → fixtures_2026.json
node scraper-mixed.mjs           # scrape York Mixed League (all seasons/divisions) from MyDivision.com
node scraper-archive.js [year]   # scrape one or all archive seasons (2018,2019,2021–2025)
node dedupe-auto.js              # apply all confirmed bulk alias decisions
node dedupe.js [--report|--manual]  # auto-approves Phase 1 (same-team, no clash); interactive Phase 2
node elo.js                      # full multi-season ELO for Mens league → ratings_all.json
node elo.js --mixed              # full multi-season ELO for Mixed league → mixed_ratings_all.json
node scripts/detect-name-conflicts.js [--write]  # find same-name different-people; write player-splits.json
node server.js                   # web UI at http://localhost:3000
node scripts/migrate-to-supabase.js  # push Mens local JSON data to Supabase (re-runnable)
node scripts/migrate-mixed-to-supabase.js --league mixed # push Mixed local JSON data to Supabase
node scripts/sql.js "SELECT ..."     # run arbitrary SQL via Supabase Management API
node scripts/validate-league-table.js [div...]  # diff computed mens tables vs the official site
/deploy                          # commit source changes with auto-generated message + push to main
```

## Match Predictor (`/predict`)

- UI at `/predict` → `public/predict/index.html` (static, no API needed beyond `/api/leaderboard`)
- **Scoring format:** The league uses "best of N games" (default 12), NOT standard tennis sets. Score = `round(p × N)` vs `N − round(p × N)`. Never use a hardcoded tennis-set lookup table.
- **Player picker dropdowns:** When a club filter is active, show ALL matching players — do not cap the list. Only cap (e.g. 10) when no filter is active and the user hasn't typed anything.

## MCP Server (remote connector)

- `api/mcp.js` — a remote MCP server exposing the league data as tools, for connecting to any MCP client (Claude, etc.) via URL: `https://<deployment>/api/mcp`
- Stateless Streamable HTTP transport (`@modelcontextprotocol/sdk`) — builds a fresh `McpServer` + transport per request since Vercel functions don't share memory across invocations. No auth (data is public league results).
- Tools: `search_players`, `get_player`, `get_leaderboard`, `get_match_history`, `compare_players`, `list_clubs` — all take an optional `league: "mens" | "mixed"` param.
- Locally testable via `server.js`, which delegates `/api/mcp` straight to the handler (same pattern as `/api/team-ratings`).
- When adding a new tool, only touch `api/mcp.js` — it reads directly from Supabase like `api/leaderboard.js` / `api/player/[name].js`, so it does NOT need the four-places update that `buildPlayerStats()` changes require.
- League-table tools (`get_league_table`, `get_team`, `list_teams`) delegate to `lib/league-table.js` — put table/scoring logic there, not in `api/mcp.js`.

## League Tables (`lib/league-table.js`)

- **Single source of truth** for match scoring and division standings. `cawood-tennis-v2` has its own TS copy in `src/lib/league-score.ts` + `useTeamStandings` (same Supabase tables) — keep the two in sync, or migrate that app onto this module.
- **Mens scoring:** W/D/L count RUBBERS (9/match, walkovers included) + 3 bonus pts to the side winning more of the 108 games (1.5 each at 54–54). Points = rubbers won + drawn/2 + bonus. Totals per match always sum to 12.
- **Mixed scoring:** match decided purely on TOTAL GAMES won; 2 pts a win, 1 a draw. Rubber W/D/L only feeds the tie-break ladder (overall GD → head-to-head GD → head-to-head rubbers won among tied teams).
- ⚠️ **Walkover rubbers are absent from `*_match_history`** — the scraper only records rubbers played. Their 12–0 games ARE in the fixture's `home_games`/`away_games`, so recover walkover wins from the gap between fixture totals and games summed off the rubbers. Never score mixed matches from summed `match_history` games.
- **Seed teams from `*_elo_fixtures`, not `*_match_history`** — otherwise a team with no results yet vanishes from the table.
- ⚠️ `status` is unreliable (future fixtures can be marked played with no games) — require `home_games > 0 || away_games > 0`.
- **Concessions are scored from published points, never derived.** The league's award varies case by case (6 pts for 55 games won, 10.5 for 76, 3 for 40 — no formula fits), so `scraper.js` captures `home_points`/`away_points` from the division page and the table adds them straight to PTS without touching W/D/L or BONUS, matching the official display. The conceding side is docked `CONCESSION_PENALTY` (6). The official table appends **one asterisk per concession** to the team name (`**` = two).
- **Fixture dates are inconsistent even within one table:** `"26 Apr 2026"`, `"16 August 2026"` (mens) and `"01.06.26"` (mixed). Use `parseLeagueDate()`; never sort the raw strings.
- `buildLeagueTable(..., { asOf })` restricts to fixtures on or before a date — this is what makes position-over-time possible.
- Tables are **unofficial**: admin points penalties and concession awards aren't in the data (the official site marks affected teams with a trailing `*`). A conceded fixture only increments played.
- **Validation:** `node scripts/validate-league-table.js` diffs every mens division against yorkmenstennisleague.co.uk. As of Aug 2026, 7 of 8 divisions match cell-for-cell (see Known Issues for the eighth). Run it after any change here.

## Vercel Deployment

- Local `server.js` does not auto-serve directory index files. Fix: `if (!path.extname(filePath)) filePath = filePath.replace(/\/?$/, '/index.html')` before `fs.readFile`. Vercel handles this automatically.
- Env vars required: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `ADMIN_PASSCODE`
- API routes live in `api/` (file-based routing). ⚠️ A directory named `api/foo/` conflicts with a vercel.json rewrite for `/foo` — use flat files (`api/foo.js`) instead.
- Static pages: put at `public/foo/index.html` for a clean `/foo` URL — Vercel auto-serves directory index files with no rewrite needed.
- `public/` files are served at root URL — rewrite destinations like `"/public/foo.html"` are wrong; use `"/foo.html"` or the directory pattern above.

## Supabase

- ⚠️ **Two-code-path architecture for stats:** `server.js` computes all stats in-memory (local dev only). Vercel reads from Supabase. When adding new player stats, update ALL FOUR: `buildPlayerStats()` in `server.js`, `buildPlayerStats()` in `scripts/migrate-to-supabase.js`, the Supabase schema (`node scripts/sql.js "ALTER TABLE york_player_stats ADD COLUMN IF NOT EXISTS ..."`), and `api/player/[name].js`. Then re-run the migration.
- `york_player_stats` / `mixed_player_stats` JSONB columns: `best_partner`, `worst_partner`, `nemesis`, `nemesis_pair`, `nemesis_club`, `best_club`
- Tables (Mens): `york_players`, `york_match_history`, `york_player_stats`, `york_aliases`, `york_elo_fixtures`
- Tables (Mixed): `mixed_players`, `mixed_match_history`, `mixed_player_stats`, `mixed_aliases`, `mixed_elo_fixtures`
- Default row cap is 1000 — use `.range(from, from+999)` pagination loop for full leaderboard (1830+ players)
- Management API (`api.supabase.com`) requires personal access token (`SUPABASE_ACCESS_TOKEN`), not the service key. Returns 200 or 201 on success.
- `york_aliases` table stores runtime merges (variant_name → canonical_name); merged with `player-aliases.json` at query time

## Date Format & Sorting

- Fixture dates are stored as `"DD MonthName YYYY"` (e.g. `"28 April 2025"`) — never sort these as plain strings or "28" sorts before "5". Parse to `Date` / timestamp first.
- Mixed league dates may come as `"DD.MM.YY"` from MyDivision; `scraper-mixed.mjs` converts these or the ELO engine handles them.

## Admin Merge Tool

- UI at `/admin` → `public/admin/index.html` (passcode-gated)
- API at `POST /api/admin-merge` — validates `ADMIN_PASSCODE`, saves alias to `york_aliases`, reruns ELO in-memory, upserts `york_players` + `york_player_stats`, renames in `york_match_history`
- ⚠️ When generating suggestion dropdowns with player names in JS, never use `JSON.stringify(name)` inside an `onclick=""` attribute — double quotes break the HTML. Use `data-*` attributes + `addEventListener` instead.

## ELO Algorithm

- **Unit of play:** Doubles rubber (pair vs pair). Team rating = average of two individual player ratings. Both players receive the same adjustment.
- **Formula:** Standard ELO — `E = 1 / (1 + 10^((opponentRating - playerRating) / 400))`, `change = K * (actual - expected)`
- **Initial rating (Mens):** Division-seeded (D1=1600, D2=1470, D3=1350, D4=1230, D5=1110, D6=1040, D7=970, D8=900) | **K:** 32 | **Floor:** 500 | **Ceiling:** 3000
- **Initial rating (Mixed):** Division-seeded (D1=1600, D2=1480, D3=1360, D4=1240, D5=1120, D6=1040, D7=960, D8=880, D9=800, D10=720)
- **No season resets** — ratings carry over continuously across seasons.
- **Sequential processing:** Rubbers within a fixture are processed in `rubber_order` sequence. Each rubber updates ratings before the next is calculated.
- **Draws (6-6):** `actualScore = 0.5` for both pairs.
- **Conceded fixtures:** Detected by "Match conceded by" text — skipped entirely, no ELO impact.
- **Cross-fixture ordering is critical:** All fixtures sorted by date before processing.

## Scraper: York Men's League

- **Source:** yorkmenstennisleague.co.uk — public HTML
- **Seasons:** 2018, 2019, 2021–2026 (no 2020 — COVID)
- **Format:** 8 divisions, 3 pairs per team, 9 rubbers per fixture

## Scraper: York Mixed League

- **Source:** mydivision.com — requires session cookies for match details.
- **Seasons:** 2023–2026
- **Format:** 10 divisions, 3 pairs per team, 9 rubbers per fixture
- **Script:** `scraper-mixed.mjs` - requires `PHPSESSID` cookie.

## Deduplication Workflow

- `player-aliases.json` (Mens) / `mixed_player-aliases.json` (Mixed)
- `player-not-dupes.json` — confirmed different-person pairs (14 auto-rejected clashes + 5 manual)
- `dedupe.js` — Phase 1 (same-team) is **auto-approved by default** (same team + no same-date clash = safe merge). Use `--manual` to review Phase 1 manually. Phase 2 (cross-team) is always interactive.
- Same-date clash detection: if two names appear in different fixtures on the same date → auto-rejected to not-dupes without prompting.
- ⚠️ d=2 same-team candidates can still be wrong (e.g. `Dave Hall Jr` vs `Dave Hall Sr`, `Zak Los` vs `Max Los`) — run with `--manual` to be safe for d=2 cases
- After any alias changes: re-run `node elo.js` → `node scripts/migrate-to-supabase.js`
- Cross-team candidates left unsplit by default — players can self-merge via the admin tool

## Player Splits (same name, different people)

- `player-splits.json` / `mixed_player-splits.json` — maps a canonical name to multiple distinct people by club
- Generated by `node scripts/detect-name-conflicts.js --write` — uses Welsh-Powell graph colouring on a club-conflict graph
- Club = team name with trailing number stripped: `"Starbeck 1"` → `"Starbeck"`, `"David Lloyd York 3"` → `"David Lloyd York"`
- Both `elo.js` and `scripts/migrate-to-supabase.js` apply splits after aliases. Largest cluster keeps original name; others get `"Name (Club)"` suffix.
- After any data change: run `detect-name-conflicts.js --write` → `elo.js` → `migrate-to-supabase.js`

## Bash / Node Gotchas

- ⚠️ `node -e` with inline code: shell escapes `!` as `\!` causing syntax errors. Write temp scripts to files instead when code contains `!`.
- Fixture field is `fixture_id` (not `id`) in local JSON files.

## Build Phases

1. **Phase 1a–c:** DONE — All 7 seasons scraped, ELO calculated, web UI live
2. **Phase 1d:** TODO — live scrape trigger for new 2025 results mid-season
3. **Phase 2:** DONE — Mixed League (MyDivision.com), unified cross-league ELO architecture

## Playwright (UI Testing)

- The Playwright MCP plugin uses system Chrome — must quit Chrome fully (Cmd+Q, not just close windows) before use, otherwise fails with "Opening in existing browser session"
- Screenshots land in project root — already gitignored via `*.png`
- Use `https://york-elo.vercel.app` for testing pages that 404 locally (e.g. `/predict`)

## Known Issues & Open Questions

- **Division 5 differs from the official table by one fixture** (Aug 2026): the site's own *fixture list* shows #717 York 4 v Racquets 2 as `4 (49) - 8 (59) [P]`, but its *standings page* has not counted it yet. Our table is ahead, not wrong — expect it to resolve itself. Everything else matches 7/8 divisions cell-for-cell.
- **The scraper freezes results it has already captured.** A fixture with player names is only re-fetched inside `RECHECK_DAYS` (7); after that `hasResults && !isRecent` reuses the cache forever. Upstream *corrections* (rubbers re-scored as walkovers) would be invisible, so `scraper.js` now also re-fetches whenever the cached scorecard stops summing to the division page's match score. Two D7 fixtures had been stale for ~6 weeks before this was added.
- **Empty scorecards are normal for a day or two.** Results posted before captains fill in rubbers appear as 9 rubbers with no player names and null games. `hasResults` is false for those, so they are re-fetched every run and self-heal — no action needed.
- **23 cross-team dedupe candidates unresolved** — left intentionally; players can self-merge via admin tool
- **~2 genuine cheats currently flagged** in `/clubs` page: Giles Holiday (2025) and Steve Jones Starbeck 1→2 (2023, intra-club — may be legitimate)
- **`url.parse()` deprecation warning** in `server.js` — harmless, can switch to WHATWG URL API if desired
