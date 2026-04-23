#!/usr/bin/env node
/**
 * York Mixed League Scraper (Full League)
 *
 * Scrapes all divisions for multiple seasons from MyDivision.com.
 * Outputs standardized mixed_fixtures_YYYY.json files.
 *
 * Usage:
 *   node scraper-mixed.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dir, '.')

// Provided Cookie from user session (Updated with full auth)
const COOKIE = 'PHPSESSID=1d01qt1mk4ft5nte6t4luilcs2; md_cookie=31536000; md_user_id=8364; md_password=JlA%2FnfJY195mddxPItVmY19dhP3Ld7rzG6'
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'

const BASE_URL = 'https://www.mydivision.com'
const LEAGUE_ID = '193'

// Season number → Year
const SEASONS = {
  '29': 2023,
  '31': 2024,
  '33': 2025,
  '35': 2026,
}

const DELAY_MS = 1000
const MATCH_DELAY_MS = 500

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithHeaders(url, options = {}) {
  const headers = { 
    ...(options.headers || {}),
    'User-Agent': USER_AGENT,
    'Cookie': COOKIE
  }
  const res = await fetch(url, { ...options, headers })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

async function fetchWithRetry(url, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fetchWithHeaders(url, options)
    } catch (err) {
      if (i === retries - 1) throw err
      console.warn(`    Retrying fetch for ${url} (${i + 1}/${retries})...`)
      await sleep(2000 * (i + 1)) // Backoff
    }
  }
}

/**
 * Finds all division IDs for a given season by looking at the division dropdown
 */
async function getDivisions(seasonId) {
  console.log(`Discovering divisions for season ${seasonId}...`)
  
  // POST is the standard way this site switches seasons
  const url = `${BASE_URL}/racketindex.php?l=${LEAGUE_ID}`
  const html = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `season=${seasonId}&get_submit=>>`
  })

  writeFileSync(`debug_discovery_${seasonId}.html`, html)

  const divisions = []
  const seenIds = new Set()

  // Find the division select dropdown: <select name="division">...</select>
  const selectMatch = /<select name="division">(.*?)<\/select>/is.exec(html)
  if (selectMatch) {
    const optionsHtml = selectMatch[1]
    const optRegex = /<option value="(\d+)"[^>]*>(?:Division\s*)?(\d+)/gi
    let match
    while ((match = optRegex.exec(optionsHtml)) !== null) {
      const id = match[1]
      const num = parseInt(match[2])
      if (!seenIds.has(id)) {
        seenIds.add(id)
        divisions.push({ id, number: num })
      }
    }
  }

  // Fallback: search for any racketindex links if select not found
  if (divisions.length === 0) {
    const divRegex = /racketindex\.php\?l=193(?:&amp;|&)d=(\d+)/g
    let match
    while ((match = divRegex.exec(html)) !== null) {
      const id = match[1]
      if (!seenIds.has(id)) {
        const context = html.substring(match.index, match.index + 150)
        const labelMatch = />\s*(?:Division\s*)?(\d+)\s*</i.exec(context)
        if (labelMatch) {
          const num = parseInt(labelMatch[1])
          if (num > 0 && num < 20) {
            seenIds.add(id)
            divisions.push({ id, number: num })
          }
        }
      }
    }
  }

  if (divisions.length === 0) {
    console.warn(`  [Warning] No divisions found for season ${seasonId}. Check debug_discovery_${seasonId}.html`)
  } else {
    console.log(`  Found ${divisions.length} divisions: ${divisions.map(d => d.number).join(', ')}`)
  }

  return divisions.sort((a, b) => a.number - b.number)
}

async function scrapeDivisionMatches(seasonId, divisionId, divNumber, year) {
  console.log(`  Scraping Div ${divNumber} (ID: ${divisionId})...`)
  const url = `${BASE_URL}/racketindex.php?l=${LEAGUE_ID}&d=${divisionId}`
  
  const html = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `season=${seasonId}&division=${divisionId}&get_submit=>>`
  })

  const rowRegex = /<tr bgcolor="#(?:efefef|e5e5e5)">\s*<td\s*>(.*?)<\/td>\s*<td align=center>(.*?)<\/td>\s*<td>(.*?)<\/td>\s*<td align=center>(.*?)<\/td>\s*<td align=center>(.*?)<\/td>\s*<td align=center bgcolor=#ffffff>(.*?)<\/td>/g
  
  const fixtures = []
  let match
  while ((match = rowRegex.exec(html)) !== null) {
    const [_, dateRaw, noteRaw, teamsRaw, setsRaw, gamesRaw, actionRaw] = match
    
    const date = dateRaw.split(' - ')[0].trim()
    const [homeTeam, awayTeam] = teamsRaw.split(' - ').map(t => t.trim())
    
    let homeSets = null, awaySets = null
    if (setsRaw.includes('v')) {
      const setsParts = setsRaw.replace(/<[^>]*>/g, '').split('v')
      homeSets = parseInt(setsParts[0])
      awaySets = parseInt(setsParts[1])
    }

    let homeGames = null, awayGames = null
    if (gamesRaw.includes('v')) {
      const gamesParts = gamesRaw.replace(/<[^>]*>/g, '').split('v')
      homeGames = parseInt(gamesParts[0])
      awayGames = parseInt(gamesParts[1])
    }

    const detailIdMatch = /toggleGet(?:Old)?Results?\s*\(\s*'(\d+)'/.exec(actionRaw)
    const matchId = detailIdMatch ? detailIdMatch[1] : null
    const mMatch = /toggleGet(?:Old)?Results?\s*\(\s*'\d+'\s*,\s*'(.*?)'/.exec(actionRaw)
    const mParam = mMatch ? mMatch[1] : ''

    if (!matchId) continue

    const fixture = {
      fixture_id: matchId,
      season: year,
      division: divNumber,
      date,
      home_team: homeTeam,
      away_team: awayTeam,
      home_sets: homeSets,
      away_sets: awaySets,
      home_games: homeGames,
      away_games: awayGames,
      source_url: `${BASE_URL}/scorecard.php?m=${matchId}`, // MyDivision common pattern
      rubbers: []
    }

    // Fetch details if match is completed
    if (homeSets !== null) {
      fixture.rubbers = await fetchMatchDetails(matchId, mParam)
      await sleep(MATCH_DELAY_MS) // Polite delay
    }

    fixtures.push(fixture)
  }

  return fixtures
}

async function fetchMatchDetails(matchId, mParam) {
  // Use user ID from cookie as prefix for mParam if possible
  const userIdMatch = COOKIE.match(/md_user_id=(\d+)/)
  const userId = userIdMatch ? userIdMatch[1] : '8364'
  const finalM = userId + mParam
    
  const url = `${BASE_URL}/include/matchdetails.php?id=${matchId}&m=${finalM}`
  try {
    const html = await fetchWithRetry(url)
    
    if (html.includes('Please login')) {
      console.warn(`    [Warning] Login required for match ${matchId}. Check if cookie is still valid.`)
      return []
    }

    // Pre-process HTML: strip out comments and noisy tags to simplify regex
    const cleanHtml = html
      .replace(/<!---.*?--->/gs, '')
      .replace(/<font[^>]*>/gi, '')
      .replace(/<\/font>/gi, '')
      .replace(/<b[^>]*>/gi, '')
      .replace(/<\/b>/gi, '')
      .replace(/<a[^>]*>/gi, '')
      .replace(/<\/a>/gi, '')
      .replace(/&nbsp;/gi, ' ')

    // Regex to match a rubber row
    // Format: <td>H1</td> <td>Player1 & Player2</td> <td>Score</td> <td>Player3 & Player4</td> <td>A1</td>
    const rubberRegex = /<td[^>]*>\s*(H[123])\s*<\/td>\s*<td[^>]*>\s*(.*?)\s*<\/td>\s*<td[^>]*>\s*(\d+-\d+)\s*<\/td>\s*<td[^>]*>\s*(.*?)\s*<\/td>\s*<td[^>]*>\s*(A[123])\s*<\/td>/gi
    
    const rubbers = []
    let match
    let rubberIdx = 1
    while ((match = rubberRegex.exec(cleanHtml)) !== null) {
      const [_, homePairId, homePlayersRaw, scoreRaw, awayPlayersRaw, awayPairId] = match
      
      const homePlayers = homePlayersRaw.replace(/\s+/g, ' ').trim()
      const awayPlayers = awayPlayersRaw.replace(/\s+/g, ' ').trim()
      
      const p1Match = homePlayers.split(' & ')
      const p2Match = awayPlayers.split(' & ')

      const parts = scoreRaw.split('-').map(s => parseInt(s.trim(), 10))
      const homeGames = parts[0], awayGames = parts[1]
      let winner = null
      if (!isNaN(homeGames) && !isNaN(awayGames)) {
        winner = homeGames > awayGames ? 'home' : (awayGames > homeGames ? 'away' : 'draw')
      }

      rubbers.push({
        rubber_order: rubberIdx++,
        home_player1: p1Match[0] || '',
        home_player2: p1Match[1] || '',
        away_player1: p2Match[0] || '',
        away_player2: p2Match[1] || '',
        home_games: homeGames,
        away_games: awayGames,
        winner
      })
    }

    if (rubbers.length === 0) {
      // Don't warn for future matches that might not have rubbers yet
      // but warn for completed ones
    } else {
      console.log(`    Parsed ${rubbers.length} rubbers.`)
    }

    return rubbers
  } catch (err) {
    console.warn(`    Failed to fetch details for ${matchId}: ${err.message}`)
    return []
  }
}

async function main() {
  for (const [seasonId, year] of Object.entries(SEASONS)) {
    console.log(`\n=== Processing Season ${year} (ID: ${seasonId}) ===`)
    
    const divisions = await getDivisions(seasonId)
    console.log(`Found ${divisions.length} divisions.`)

    const seasonFixtures = []
    for (const div of divisions) {
      const divFixtures = await scrapeDivisionMatches(seasonId, div.id, div.number, year)
      seasonFixtures.push(...divFixtures)
      await sleep(DELAY_MS)
    }

    const outPath = resolve(ROOT, `mixed_fixtures_${year}.json`)
    const output = {
      scraped_at: new Date().toISOString(),
      season: year,
      fixture_count: seasonFixtures.filter(f => f.rubbers.length > 0).length,
      rubber_count: seasonFixtures.reduce((n, f) => n + f.rubbers.length, 0),
      fixtures: seasonFixtures
    }
    
    writeFileSync(outPath, JSON.stringify(output, null, 2))
    console.log(`Saved ${seasonFixtures.length} matches to ${outPath}`)
  }

  console.log('\nAll seasons complete.')
}

main().catch(err => {
  console.error('Fatal Error:', err)
  process.exit(1)
})
