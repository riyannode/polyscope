---
name: polyscope-soccer-research
description: Research a soccer match with PolyScope API evidence, host-native browser research, independent regulation-time probability estimates, and Polymarket CLOB prices.
---

# PolyScope Soccer Research

PolyScope is a lightweight PayBox and Polymarket MCP integration. It returns structured provider evidence and deterministic calculations. The agent owns research interpretation, browser use, probabilistic reasoning, and recommendations. API gaps are prompts to continue research, not a reason to stop or a trading eligibility rule.

## Workflow

1. Identify the exact fixture, competition, home and away teams, and UTC kickoff. Use `research_soccer` for the football-data.org fixture and available recent results. Preserve the returned provider IDs as provider-specific identifiers.
2. For an exact fixture, call `research_soccer` with `includeApiFootball: true` when API-Football enrichment adds value and its host-scoped credential is configured. It is opt-in and makes one fixture lookup plus two team-statistics requests. Verify the returned fixture identity before using its statistics. Never join providers by numeric IDs.
3. Read `get_soccer_news` for the teams. Treat headlines as reports, not verified injury or lineup records. Keep all partial form and report its actual counts and date span.
4. Build a checklist of supplied evidence and remaining topics. Investigate recent results and form, home/away performance, league standings, head-to-head history, goals scored/conceded, xG/xGA, injuries and suspensions, confirmed and predicted lineups, team news and manager statements, rest days, fixture congestion, conflicting reports, and material uncertainty.
5. When a relevant topic is missing, incomplete, or disputed, continue with the host's web search or browser tools. Search with both exact team names, competition, match date, and topic, for example: `Arsenal Chelsea Premier League 2026-10-17 xG xGA provider`, `Arsenal Chelsea Premier League 2026-10-17 injury suspension official`, or `Arsenal Chelsea Premier League 2026-10-17 predicted lineup`. Adapt the query to the match.
6. Prefer official club and competition sources for announcements and manager statements. Trace statistics to the original provider where possible. Name the xG/xGA model or statistics provider because providers may disagree. Cross-check material or disputed details when practical.
7. Keep official, confirmed starting lineups separate from predicted lineups. Attribute injury reports as confirmed, reported, questionable, or speculative according to the cited source. Do not turn a rumor into a confirmed absence.
8. For each browser finding, cite its original URL and record the source's publication time and your access time separately when available. Never invent a timestamp. If searches cannot verify a detail, state what was searched and what remains unknown.
9. If the host does not provide browser/search capability, state that browser-based expansion was not possible and list material topics that remain unverified. Do not imply a search occurred.
10. When relevant, use `search_markets` to find the exact Polymarket market and outcome asset. Read its published resolution rules; do not assume every soccer market means a 90-minute result. Use `get_quote` for current CLOB bid/ask depth, visible fillability, fees, and quote time. A midpoint or Gamma indicative price is not an executable price.
11. For a market whose resolution rules exactly match regulation-time Home/Draw/Away, pass the exact fixture and `get_quote` result to `analyze_soccer_edge`. This read-only tool uses API-Football venue-specific season-to-date goals averages as of the UTC day before kickoff when usable; otherwise it can use the returned pre-kickoff, same-venue recent results from football-data.org. It applies an independent Poisson score model, normalizes its truncated score grid, and reports its tail, inputs, sample sizes, assumptions, sources, and uncertainty. It does not use Polymarket prices to estimate probabilities. Missing model inputs return an honest unavailable status.
12. Do not map regulation-time probabilities to extra-time winners, qualification, totals, both-teams-to-score, or other resolution rules. Unsupported market semantics must remain unsupported. SELL economics also need an existing position and sale-proceeds basis; the current calculation reports SELL analysis unavailable.
13. Present API evidence, browser findings, third-party forecasts, independent model estimates, Polymarket prices, and your recommendation as separate categories. Explain uncertainty, visible fillability, price, fees, net edge, and expected value where available. A positive edge is an estimate, not guaranteed profitability; negative edge does not establish impossibility.
14. You may recommend **TRADE** or **NO TRADE** based on the evidence and explain why. This is your analysis, not a PolyScope status or eligibility gate. The user decides whether to trade. Do not call PayBox signing or trading tools without explicit user authorization.

## Provider coverage

- **football-data.org** supplies the current baseline for PL, PD, SA, and CL fixtures, results, and available recent form. Its counts and coverage labels describe only what that API returned.
- **API-Football** is optional. `includeApiFootball: true` on an exact fixture requests `/fixtures?date=...`, matches competition, both normalized team names, and exact UTC kickoff, then requests `/teams/statistics` for the provider's own team, league, and season IDs. Statistics are capped at the UTC calendar day before kickoff. Provider IDs remain separate. Missing credentials, endpoint permissions, competition coverage, statistics fields, or a unique matching fixture must not erase football-data.org evidence.
- The team-statistics response is not xG. Do not infer xG/xGA from goals averages, and do not describe API-Football's `/predictions` endpoint as a PolyScope model. Any third-party forecast must be labeled with its provider.
- **TheSportsDB** free v1 endpoints have endpoint-specific limits and coverage constraints; free team-event schedules show only home events. PolyScope does not call it automatically. Use it only when it can provide a useful, independently identified piece of evidence, and preserve its event IDs separately.

## Three continuation examples

- **Form returned, xG missing:** Use the returned form and its counts, then search host-native sources for each team's xG/xGA for the relevant date range. Name and link the original statistics provider. If browsing is unavailable, say the xG topic was not independently researched.
- **Injury information missing:** Search official club updates and reputable reporting for the exact teams and match date. Separate confirmed absences from doubts, reports, and speculation; cite source URLs and timestamps and explain unresolved conflicts.
- **Browser unavailable:** Use available PolyScope evidence, state that browser research could not be performed, list material topics still unverified, and do not invent findings.
