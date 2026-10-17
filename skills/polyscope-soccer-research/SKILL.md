---
name: polyscope-soccer-research
description: Use when analyzing a soccer match with PolyScope. Combine its football-data.org and ESPN API evidence with host-native web search or browser research for missing or incomplete topics, then check relevant Polymarket prices and liquidity.
---

# PolyScope Soccer Research

PolyScope is a thin research and trading integration plugin. The agent owns research reasoning and browser use; PolyScope supplies structured API evidence and context. API gaps are prompts to continue research, not a reason to stop or a trade-eligibility rule.

## Workflow

1. Identify the exact match, competition, kickoff date and time, and the teams. If needed, call `research_soccer` for the competition and date, then call it with the exact `fixtureId` to retrieve available team form. Call `get_soccer_news` for both teams.
2. Treat the returned fixtures, scores, results, per-team form counts, source URLs and observation times as football-data.org evidence. Use all returned form, including partial results; report the actual counts and date range. Do not label a partial sample as a full last-five record.
3. Make a research checklist from what is supplied and what remains missing. `football-data.org` does not supply all relevant match context. Continue with host-native web search or browser tools for missing information; do not stop because a field or provider is unavailable.
4. Investigate recent form and results, home/away performance, league standings, head-to-head history, goals scored and conceded, xG and xGA, injuries and suspensions, confirmed and predicted lineups, team news and manager statements, rest days, fixture congestion, and conflicting reports or material uncertainty.
5. For each missing topic, search using both exact team names, the competition, and the match date. Make the query specific, for example: `Arsenal Chelsea Premier League 17 October 2026 xG xGA`, `Arsenal Chelsea Premier League 17 October 2026 injury suspension`, or `Arsenal Chelsea Premier League 17 October 2026 predicted lineup`. Adapt team, competition, date, and topic to the match.
6. Prefer official club and competition sources for announcements and statements. Trace statistics to the original provider where possible. Name the xG model/provider because models can disagree. Cross-check disputed or material claims where practical.
7. Keep confirmed team sheets separate from predicted lineups. Predictions, journalist reports, and rumors are not official lineups. Attribute reported injuries and describe uncertainty when status is not confirmed.
8. Record the original URL and publication or observation timestamp for browser findings. Distinguish source time from the time you accessed it. Do not invent a timestamp where a source provides none.
9. If the host has no browser or web search capability, say browser-based expansion was not possible and identify the topics that remain unverified. If searches do not verify a detail, state that limitation accurately; never fill gaps with guessed data.
10. When relevant, call PolyScope market discovery and quote tools to check current Polymarket prices, visible liquidity, spread, and quote time. Identify those as market data, not match evidence.
11. Present a source-backed analysis that separates API evidence, browser findings, disagreement, and uncertainty. The user decides whether to trade. Research gaps do not force `SKIP`, block an order, impose minimum article counts or confidence thresholds, or create another approval gate. Never invoke PayBox signing or trading tools without explicit user authorization.

## Three continuation examples

- **Form returned, xG missing:** Use the API form and its counts, then search host-native sources for both teams' xG/xGA for recent matches. Name the provider/model and link the original source. If the host cannot browse, say xG was not independently researched.
- **Injury information missing:** Search official club updates and reputable reporting for the exact teams and match date. Separate confirmed absences from doubts and speculation, cite URLs/timestamps, and report unresolved conflicts.
- **Browser unavailable:** Use only the available PolyScope evidence, explicitly state that browser research could not be performed, list the material topics still unverified, and do not invent browser findings.
