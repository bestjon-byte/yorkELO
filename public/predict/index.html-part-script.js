'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let allPlayers = [];
let allClubs   = [];
const sel       = {};  // slotKey → { name, rating }
const callbacks = {};  // slotKey → onChange fn
const slotGroup = {};  // slotKey → 'home' | 'away' | 'rubber' | 'rotation'

const clubFilters = {
  home:     '',
  away:     '',
  rubber:   new Set(),
  rotation: new Set(),
};

let currentLeague = new URLSearchParams(window.location.search).get('league') || 'mens';

// ── League Management ────────────────────────────────────────────────────────
function setLeague(league) {
  if (currentLeague === league) return;
  currentLeague = league;
  
  document.body.classList.toggle('mixed', league === 'mixed');
  document.getElementById('btnMens').classList.toggle('active', league === 'mens');
  document.getElementById('btnMixed').classList.toggle('active', league === 'mixed');
  document.getElementById('mainTitle').innerHTML = `York ${league === 'mixed' ? 'Mixed' : 'Men\'s'} Tennis — <span>Predictor</span>`;
  
  const url = new URL(window.location);
  url.searchParams.set('league', league);
  window.history.pushState({}, '', url);

  // Clear selections
  for (const k in sel) delete sel[k];
  clubFilters.home = '';
  clubFilters.away = '';
  clubFilters.rubber.clear();
  clubFilters.rotation.clear();

  init();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function ratingColor(r) {
  if (r >= 2000) return '#f5a623';
  if (r >= 1700) return '#a78bfa';
  if (r >= 1400) return '#3b82f6';
  if (r >= 1100) return '#10b981';
  return '#64748b';
}
function divColor(d) { return ['','#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#3b82f6','#8b5cf6','#ec4899'][d] || '#64748b'; }

// ── ELO Math ──────────────────────────────────────────────────────────────────
function winProb(homeAvg, awayAvg) { return 1 / (1 + Math.pow(10, (awayAvg - homeAvg) / 400)); }

function totalGames() { return Math.max(1, parseInt(document.getElementById('gamesInput').value, 10) || 12); }

// Predict score for a rubber played over `games` total games.
// Winner gets round(p * games), loser gets the remainder.
function probToScore(p) {
  const games = totalGames();
  const homeGames = Math.round(p * games);
  return [homeGames, games - homeGames];
}
function cellBg(p) {
  const d = Math.abs(p - 0.5) * 2;
  if (p > 0.5) return `rgba(124,107,221,${(0.06 + d * 0.24).toFixed(2)})`;
  if (p < 0.5) return `rgba(224, 82, 82,${(0.06 + d * 0.22).toFixed(2)})`;
  return 'rgba(148,163,184,0.08)';
}
function pairAvg(k1, k2) { return ((sel[k1]?.rating || 0) + (sel[k2]?.rating || 0)) / 2; }

// ── Player pool ───────────────────────────────────────────────────────────────
function getPool(slotKey, query) {
  const q     = query.toLowerCase().trim();
  const group = slotGroup[slotKey];
  let pool    = allPlayers;
  let filtered = false;
  if      (group === 'home'     && clubFilters.home)              { pool = allPlayers.filter(p => p.club === clubFilters.home);             filtered = true; }
  else if (group === 'away'     && clubFilters.away)              { pool = allPlayers.filter(p => p.club === clubFilters.away);             filtered = true; }
  else if (group === 'rubber'   && clubFilters.rubber.size > 0)   { pool = allPlayers.filter(p => clubFilters.rubber.has(p.club));          filtered = true; }
  else if (group === 'rotation' && clubFilters.rotation.size > 0) { pool = allPlayers.filter(p => clubFilters.rotation.has(p.club));       filtered = true; }
  if (q) return pool.filter(p => p.name.toLowerCase().includes(q)).slice(0, 12);
  // When a club filter is active show all matching players; otherwise cap at 10 as a hint
  return filtered ? pool : pool.slice(0, 10);
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  document.body.classList.toggle('mixed', currentLeague === 'mixed');
  document.getElementById('btnMens').classList.toggle('active', currentLeague === 'mens');
  document.getElementById('btnMixed').classList.toggle('active', currentLeague === 'mixed');
  document.getElementById('mainTitle').innerHTML = `York ${currentLeague === 'mixed' ? 'Mixed' : 'Men\'s'} Tennis — <span>Predictor</span>`;

  // Update nav links to preserve league
  document.querySelectorAll('nav a').forEach(a => {
    const url = new URL(a.href, window.location.origin);
    url.searchParams.set('league', currentLeague);
    a.href = url.pathname + url.search;
  });

  const res  = await fetch(`/api/leaderboard?league=${currentLeague}`);
  const data = await res.json();
  allPlayers = data.leaderboard;
  allClubs   = data.clubs;

  buildTeamSelects();
  buildSingleRubberPickers();
  buildRotationPickers();
  
  updateAll();
}
