// ── State ─────────────────────────────────────────────────────────────────
let allTeams = [];
let seasonCount = 2;
let minAppearances = 3;
let divFilter = 0; // 0 = all
let currentLeague = new URLSearchParams(window.location.search).get('league') || 'mens';

// ── League Management ────────────────────────────────────────────────────────
function setLeague(league) {
  if (currentLeague === league) return;
  currentLeague = league;
  
  document.body.classList.toggle('mixed', league === 'mixed');
  document.getElementById('btnMens').classList.toggle('active', league === 'mens');
  document.getElementById('btnMixed').classList.toggle('active', league === 'mixed');
  document.getElementById('mainTitle').innerHTML = `York ${league === 'mixed' ? 'Mixed' : 'Men\'s'} Tennis — <span>Clubs</span>`;
  
  const url = new URL(window.location);
  url.searchParams.set('league', league);
  window.history.pushState({}, '', url);

  init();
}

// ── Colour helpers ─────────────────────────────────────────────────────────
function ratingColor(r) {
  if (r >= 2000) return '#f5a623';
  if (r >= 1700) return '#6d5acd';
  if (r >= 1400) return '#3b82f6';
  if (r >= 1100) return '#10b981';
  return '#64748b';
}

function divColor(d) {
  const cols = ['','#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#3b82f6','#8b5cf6','#ec4899','#ec4899','#ec4899'];
  return cols[d] || '#64748b';
}

function wrClass(wr) {
  if (wr == null) return '';
  if (wr >= 60) return 'wr-good';
  if (wr >= 40) return 'wr-ok';
  return 'wr-bad';
}

// Rating bar width: map 900–2000 → 10–100%
function ratingBarWidth(r) {
  return Math.min(100, Math.max(10, ((r - 900) / (2000 - 900)) * 90 + 10));
}

// ── Fetch ──────────────────────────────────────────────────────────────────
async function load() {
  document.getElementById('main').innerHTML =
    '<div class="loading"><div class="spinner"></div> Loading team data…</div>';

  try {
    const res = await fetch(`/api/team-ratings?seasons=${seasonCount}&minAppearances=${minAppearances}&league=${currentLeague}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allTeams = data.teams || [];
    const seasonLabel = data.includedSeasons.length === 1
      ? `${data.includedSeasons[0]} season`
      : `${data.includedSeasons[0]}–${data.includedSeasons[data.includedSeasons.length - 1]} seasons`;
    document.getElementById('subtitle').textContent =
      `Team strength ratings · ${seasonLabel} · min ${data.minAppearances} games per player`;
    render();
  } catch (e) {
    document.getElementById('main').innerHTML =
      `<div class="empty"><h3>Failed to load</h3><p>${e.message}</p></div>`;
  }
}

function buildDivFilters() {
  const el = document.getElementById('divBtns');
  el.innerHTML = '';
  const maxDiv = currentLeague === 'mixed' ? 10 : 8;
  const divs = [0];
  for (let i = 1; i <= maxDiv; i++) divs.push(i);

  divs.forEach(d => {
    const btn = document.createElement('button');
    btn.className = 'tog-btn' + (d === divFilter ? ' active' : '');
    btn.textContent = d === 0 ? 'All' : `D${d}`;
    btn.onclick = () => {
      divFilter = d;
      document.querySelectorAll('#divBtns .tog-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      render();
    };
    el.appendChild(btn);
  });
}

function init() {
  document.body.classList.toggle('mixed', currentLeague === 'mixed');
  document.getElementById('btnMens').classList.toggle('active', currentLeague === 'mens');
  document.getElementById('btnMixed').classList.toggle('active', currentLeague === 'mixed');
  document.getElementById('mainTitle').innerHTML = `York ${currentLeague === 'mixed' ? 'Mixed' : 'Men\'s'} Tennis — <span>Clubs</span>`;

  // Update nav links to preserve league
  document.querySelectorAll('nav a').forEach(a => {
    const url = new URL(a.href, window.location.origin);
    url.searchParams.set('league', currentLeague);
    a.href = url.pathname + url.search;
  });

  buildDivFilters();
  load();
}

init();
