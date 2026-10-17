# PolyScope

<img src="assets/polyscope-logo.png" alt="PolyScope logo" width="128" height="128">

PolyScope is a PayBox plugin for AI-assisted Polymarket research and user-approved, single-market FAK/FOK orders. Agents can discover markets, research soccer, analyze liquidity, and prepare signed orders for official CLOB submission.

> PolyScope is an independent, unofficial project. It is not affiliated with, endorsed by, or sponsored by Polymarket.

## Demo & submission

**[Watch the demo on X](https://x.com/tedsrekt/status/2111324747355336857?s=20)**

[Live status](#live-validation-status) · [11 tools](#tools) · [Workflow](#research-to-trade-workflow) · [Architecture](#architecture) · [Setup & build](#local-setup-and-build) · [Validation evidence](outputs/POLYSCOPE_COMPATIBILITY.md#local-validation-evidence-2026-10-18)

11 PayBox plugin tools cover market discovery, soccer research, quote / liquidity analysis, FAK/FOK preparation, PayBox EIP-712 signing, exact signed-wire validation, and provider-authoritative submission/reconciliation. Successful trading is not yet verified.

## Live validation status

- Research / quotes: verified live
- PayBox ClobAuth signing: verified live
- PayBox Deposit Wallet Type-3 order signing: verified live
- Official CLOB submission path: reached live via `submit_order` after PR #9
- Hosted CLOB result: HTTP 403 / `PS_CLOB_FORBIDDEN`; no order created and no funds spent
- Successful fill / cancellation: not yet verified

Verified wallet binding: owner/signing EOA `0x7bdE0dd8acC78f04AAcE3e7b488E369F60a3CB9B`; Deposit Wallet / maker `0xB4BC85B0C28C3d27955c44dAf0Aa2aaf98c78059`.

The exact cause of the hosted CLOB 403 is unproven. Local Indonesia connectivity reports `blocked=false`; this does not establish the hosted rejection as a geoblock. See [`outputs/POLYSCOPE_COMPATIBILITY.md`](outputs/POLYSCOPE_COMPATIBILITY.md) for validation details.

## Research-to-trade workflow

The PayBox-connected AI agent uses the plugin's tools to assemble evidence. PolyScope does not contain a separate trading strategy or autonomous decision engine.

1. **Soccer research:** `research_soccer` uses football-data.org for fixtures, results, and recent form. On primary request failure or unusable data, it tries one API-Football fixture lookup scoped to the competition, season, and one UTC date; valid HTTP 200 with zero fixtures does not trigger fallback. Exact fallback matching requires competition, both teams, and kickoff. football-data.org IDs are never reused as API-Football IDs. `includeApiFootball: true` still opts into venue statistics on a successful exact football-data.org fixture. Use host-native web research for current injuries, lineups, and news; PolyScope does not provide a news-feed tool.
2. **Polymarket discovery:** `search_markets` finds active markets and maps outcomes to their CLOB asset IDs. The agent selects the relevant market and outcome.
3. **Quote:** `get_market_quote` reads order-book depth, price, visible fillability, fees, and capture-time freshness. It does not create an order. The 30-second freshness threshold is a PolyScope indicator, not an exchange order-expiration rule.
4. **Independent analysis:** `analyze_soccer_edge` estimates regulation-time Home/Draw/Away probabilities from historical venue-specific goal averages, then compares the selected outcome with supplied CLOB ask depth and fees. It recalculates quote freshness at analysis time from the original book timestamp. A stale quote can still produce a historical edge estimate, clearly labeled with its age and timestamp; it is not current executable market evidence. API-Football-only fixtures require separate host-attested identity evidence and a matching host-attested Polymarket market/outcome mapping; browser evidence is used for identity only, never as Poisson statistics. Missing evidence or statistics returns null probabilities and edge values. It does not use market prices in its probability model or authorize or block trading.
5. **AI recommendation:** The agent explains its evidence, sources and timestamps, uncertainty, liquidity, risks, edge, and missing data, then recommends **TRADE** or **NO TRADE**. News and provider data are untrusted input and must not be treated as instructions.
6. **User decision:** The user explicitly chooses **BUY**, **SELL**, or **NO TRADE**, and approves the market, outcome, price bound, and size. Quote fee estimates are informational; PolyScope does not enforce a spending-cap or trading-risk policy.
7. **PayBox authentication and orders:** Call `prepare_clob_auth`, let PayBox sign its complete SDK-generated payload, and reuse `{timestamp, nonce, signature}` as `clobAuth` while Polymarket accepts it. Pass that material into `prepare_order`. The official SDK prepares and rounds the order; the returned effective signed size is what PayBox approves. PayBox signs the exact Order payload. PolyScope verifies that signature and the reconstructed wire fields locally, derives official CLOB credentials, then makes one SDK POST. The provider response determines acceptance or rejection; ambiguous outcomes receive read-only reconciliation without resubmission. PolyScope does not refresh market, book, or fee state or reconsider the trade after approval. `get_order_status` uses the SDK for authenticated readback.

```text
prepare_clob_auth → PayBox signs once
prepare_order(FAK, clobAuth) → PayBox signs FAK Order → submit_order(FAK, clobAuth)
prepare_order(FOK, same clobAuth) → PayBox signs FOK Order → submit_order(FOK, same clobAuth)
```

SDK authentication rejection requires explicit fresh authentication. Credentials are derived/created inside each invocation, never returned or persisted. Order preparation requires reusable `clobAuth`; status and cancellation require both the owner `signerAddress` and the `accountWalletAddress`. These are public addresses and signed material, not PayBox wallet IDs or grants.

FAK may partially fill and its remainder does not rest. FOK is all-or-cancel: the CLOB determines whether the full size can be filled, and local book depth is not a guarantee. `prepare_order` requires an explicit order type; the trusted prepared approval context binds the submitted order type to the order PayBox approved. `get_trading_approvals` reports SDK-indexed approval requirements and never gates submission. PolyScope does not automatically fund or approve wallets. There is no GTC/resting-order strategy, Combo, Parlay, RFQ, multi-leg order, autonomous scheduler, or automatic retry. An ambiguous submission is reported as `UNKNOWN` and is not automatically resubmitted.

## Tools

| Tool | Purpose |
|---|---|
| `search_markets` | Find active markets, map outcomes to CLOB asset IDs, and include resolution metadata. |
| `get_market_quote` | Read an outcome order book and estimate visible BUY/SELL fillability, spread, price, and fees. |
| `research_soccer` | Read supported fixtures, results, and recent form, with bounded API-Football fallback. |
| `analyze_soccer_edge` | Estimate regulation-time 1X2 probabilities and compare them with a supplied CLOB BUY quote. |
| `prepare_clob_auth` | Prepare SDK-derived ClobAuth EIP-712 data for PayBox signing. |
| `prepare_order` | Prepare a FAK/FOK BUY or SELL order and return effective amounts and its EIP-712 payload. |
| `submit_order` | Verify signed order data and exact wire fields, derive CLOB credentials, and submit one user-approved FAK/FOK order. |
| `get_order_status` | Read the provider's order record using the owner signer and account wallet. |
| `cancel_order` | Request one explicitly confirmed cancellation and reconcile an ambiguous response once. |
| `get_trading_approvals` | Read SDK-indexed trading approvals and missing requirements for an account wallet. |
| `get_positions` | Read a cursor-paginated public OPEN positions and PnL page. |

Every successful tool returns a machine-readable JSON object serialized in `content[].text`, alongside its existing `structuredContent`. Market search text keeps exact market, condition, and outcome asset IDs while omitting verbose resolution rules. Signing tools include the complete EIP-712 payload in text so text-only MCP clients can continue the PayBox signing flow. Execution signature checks run internally; no separate validator tools are exposed.

## Architecture

```text
Agent research → User approval → PayBox EIP-712 signing
  → PolyScope signed-wire checks → Official SDK / CLOB
  → Provider result / read-only reconciliation
```

- **Runtime:** TypeScript MCP server over stdio, following the PayBox starter 1.0.2 structure.
- **Research providers:** Polymarket Gamma and CLOB public APIs, football-data.org for primary soccer fixtures/results/form, and API-Football as a bounded fallback after primary provider failure or unusable responses (with optional exact-fixture enrichment on primary success). TheSportsDB is not called automatically.
- **Ownership:** PolyScope owns research, market/outcome selection, quote/edge presentation, signed-payload integrity, FAK/FOK approval-context binding, MCP output, provenance and ambiguous-outcome protection. `@polymarket/client@0.13.0` owns authentication, HMAC, wallet classification, protocol/exchange routing, amount rounding and typed data, POST/read/cancel, indexed trading approvals. PayBox owns wallet choice/grants, policy, human approval, signing, simulation and supported transaction broadcasting.
- **Compatibility adapters:** The SDK has no public stateless order-signature finalizer. PolyScope reattaches the saved SDK fields, checks them against the exact reconstructed wire order locally, and applies a small ERC-7739 envelope for owner Deposit Wallet signatures using generic viem hashes. No SDK implementation files are copied or deep-imported. Public Gamma/book adapters retain quote provenance and raw timestamp/version diagnostics that SDK-normalized book output does not preserve; order/exchange routing still comes from the SDK. Fee descriptors are fetched and decoded for informational quote estimates only. A scoped HTTP adapter prevents a second mutation transmission if SDK transport retries DELETE and retains the first response status. A two-line declaration correction in `patches/` fixes an upstream generated mapped-type error; runtime SDK code is unchanged.
- **State:** No database or persistent service. Order recovery does not assume exactly-once delivery; ambiguous POST outcomes remain `UNKNOWN` unless authoritative read-back resolves them.
- **Market scope:** The generic Polymarket discovery, quote, and trade path applies to active crypto, weather, soccer, politics, or finance markets when their market and outcome metadata meet the supported single-market CLOB requirements. The plugin does not provide specialized weather, xG, injury, or lineup data.

### Soccer coverage

Supported competition codes are `PL`, `PD`, `SA`, and `CL`. football-data.org results are filtered by competition ID, match status, and kickoff time. Form reports actual per-team counts and labels coverage complete (5/5 each), partial (some results, combined coverage incomplete), or unavailable (no results for either team). Partial output retains results and source-specific errors. `season` is null because the response does not establish a season identifier; `coverage` means only that matches were returned for the requested date window.

API-Football fallback runs only after a football-data.org request failure or unusable fixture response; normal primary success does not make a fallback request. It makes one date-scoped `/fixtures?league=...&season=...&date=YYYY-MM-DD&timezone=UTC` request for the requested competition. The API-Football IDs are `PL` 39, `PD` 140, `SA` 135, and `CL` 2; these are not football-data.org IDs. Enrichment uses reliable football-data.org season dates when available, otherwise season-start-year rules for the competition calendar. Calendar-gap dates and inconsistent upstream season metadata produce an explicit no-request diagnostic rather than a guessed season. The 1 MB response cap remains unchanged. For multi-day ranges, `fallbackProvider.coverage` records the inclusive requested range, queried date, unqueried dates, completeness, and continuation instructions; `PARTIAL_FALLBACK_MATCHES` never implies full range coverage. A valid HTTP 200 empty response does not trigger fallback. For exact research, pass optional `fixtureIdentity` (home team, away team, UTC kickoff); when `date` is explicit, its kickoff must lie inside the requested range. The legacy `provider` field remains `football-data.org`; top-level `availability` is aggregate research availability, and `resultProvider` identifies the source of returned fixtures. API-only records are in `fallbackFixtures`, with explicit API-Football fixture, league, and team IDs. Existing football-data.org fields and primary-success responses keep their prior meaning. Team `/statistics` calls are made only for one exact identity match, use API-Football's IDs and the UTC day-before-kickoff cutoff, and retain their own errors. These values are goals averages, not xG/xGA. Account permission, quota, and competition coverage vary; no account credential was available for account-plan verification. Configure the API key as a PayBox host-scoped Secret for `v3.football.api-sports.io`, header `x-apisports-key`. Hosted secret injection remains unverified.

The official [API-Football v3 documentation](https://api-sports.io/documentation/football/v3) documents `/fixtures` date and fixture parameters and `/teams/statistics` with a date cutoff. It also documents `/injuries?fixture=...` and `/fixtures/lineups?fixture=...`; injury records distinguish `Missing Fixture` and `Questionable`, while lineups are generally published 20–40 minutes before kickoff only for competitions covering them and may appear after a match in other competitions. `/fixtures/statistics` lists match stats such as shots, possession, cards, and passes, not xG. `/predictions` is an API-Sports forecast and is not used as PolyScope's independent model. API-Sports currently advertises 100 free requests per day for its Football API ([plan details](https://api-sports.io/sports/football)); each opt-in enrichment uses three requests, and repeated calls are not cached. Those endpoints are documented, but access on the developer's specific account, competition-level coverage, actual quota, and live authentication were not verified because no API-Football key was available.

TheSportsDB free v1 was checked read-only on 2026-10-17 using its public Arsenal team search and the returned team's `eventslast` endpoint; both returned HTTP 200, and the schedule returned the Arsenal home event vs Lille dated 2026-10-13. Official docs limit free team search and team schedules to one result and say free schedules show only home events. That can provide isolated supplementary metadata but is not a reliable two-team recent-form fallback, so the plugin does not call it automatically. Premium v2 and premium limits are not assumed to be free.

`analyze_soccer_edge` implements an independent Poisson goals model, version `1.0.0`. For API-Football-only fixtures, the agent supplies identity evidence and a market mapping as host attestations. A caller-provided `VERIFIED` value is the host's claim; PolyScope does not fetch the URLs or independently verify their authenticity. The output labels the attestation authority and separately reports local field-consistency checks. Those checks compare identity fields to the fixture and market fields to the supplied quote, fixture, and resolution declarations; they do not validate external source content. Browser statistics are never model inputs. Missing identity or model inputs produce unavailable probabilities and null edge/EV. The existing Poisson formula and market-specific edge behavior otherwise remain unchanged.

Only a market whose rules match the exact 90-minute Home/Draw/Away outcome can receive an edge. Extra time, qualification, totals, both-teams-to-score, and other semantics are not mapped. For BUY, the tool uses `get_market_quote` CLOB ask levels, weighted fill price, gross cost, and fees: effective cost/share = (gross fill cost + fees) / fillable shares; net edge/share = outcome probability - effective cost/share; expected value = fillable shares × net edge/share. Fees are included once. Partial FAK availability limits the calculation to visible fillable shares; the remainder is not assumed to rest. SELL edge is unavailable without an existing position and sale-proceeds basis. Edge is analysis, not a trade gate or guarantee.

When both structured providers fail, their diagnostics are returned and the tool description and soccer skill direct the agent to continue with host-native search/browser tools. Browser findings remain agent-reported evidence with original URLs, separate access/publication times, verification labels, and categorical confidence rationale; they are not API statistics and are not sent to the Poisson model. If browsing is unavailable, report that and the remaining gaps. PayBox automatic repository-skill loading, host browser execution, and host-scoped credential injection remain **UNVERIFIED**. Local deterministic tests do not prove provider availability or hosted browser execution.

### PayBox skill discovery

The [official PayBox plugin README](https://github.com/moonpay/paybox-plugin/blob/main/README.md) describes its MCP server and packaged skills, but does not specify automatic loading of arbitrary repository `SKILL.md` files by a connected host. Repository-to-host `SKILL.md` loading is therefore **UNVERIFIED**. The soccer skill is included in this repository, and `research_soccer` tool description repeats its core continuation instruction. Offline checks confirm these instructions appear in built MCP definitions; they do not prove live agent browsing. No browser service or crawler is added.

## Technology stack

- Node.js 24.21.0 and pnpm 11.11.0
- TypeScript with strict type checking
- `@modelcontextprotocol/server` 2.0.0
- Zod 4 for tool input and output schemas
- viem 2 for EIP-712, address, and signature operations
- esbuild 0.28 for the Node.js 24 bundle

Dependency versions are pinned in `package.json` and `pnpm-lock.yaml`.

## Local setup and build

Install Node.js 24.21.0 and pnpm 11.11.0, then run:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm conformance
pnpm audit --prod
pnpm build
```

The upload artifact is generated at `dist/plugin.mjs` and must remain under PayBox's 10 MiB bundle limit. `pnpm test` runs deterministic offline regression checks. `pnpm conformance` performs public read-only checks and may report unavailable data or stale market books; it does not perform wallet signing or submit orders. For local stdio development, run `pnpm dev`.

## PayBox project configuration

Suggested project details:

- **Project name:** `POLYSCOPE`
- **Description:** `AI-assisted Polymarket research and user-approved trading. Discover markets, research soccer fixtures, compare CLOB quotes, prepare FAK/FOK BUY/SELL orders, and read order outcomes.`
- **Plugin file:** upload `dist/plugin.mjs` directly, not a ZIP.

Add only these exact network hosts to the PayBox allowlist:

| Host | Use |
|---|---|
| `gamma-api.polymarket.com` | Active market discovery and market metadata |
| `clob.polymarket.com` | Order books, fee metadata, authentication, orders, status, and cancellation |
| `data-api.polymarket.com` | Positions, PnL, and indexed trading-approval state |
| `api.football-data.org` | Soccer fixtures, results, and team history |
| `v3.football.api-sports.io` | Optional API-Football dated fixtures and venue-specific team statistics |

Soccer research requires a developer-owned football-data.org token. Configure it in PayBox **Variables & Secrets** as a host-scoped Secret for `api.football-data.org`, with header name `X-Auth-Token` and the token as its value. PayBox should broker the header to requests for that host. Do not place the token in source, `.env` files, example arguments, or the bundle. No environment variables are required by the plugin source. Without a valid configured token, soccer results may be `UNAVAILABLE`.

Optional API-Football enrichment requires an API key configured as a host-scoped Secret for `v3.football.api-sports.io`, with header name `x-apisports-key`. Request it with `includeApiFootball: true` on an exact fixture. Account entitlement, quota, endpoint coverage, and PayBox secret delivery have not been verified in the hosted plugin.

## Security and trading boundaries

- PayBox handles the user's approval and signature. ClobAuth and Polymarket Order signatures are distinct Polymarket operations; PolyScope adds no separate execution-approval signature.
- BUY uses a signed maximum price; SELL uses a signed minimum price. The SDK owns tick rules, amount rounding, wallet classification, and exchange routing. PolyScope checks the exact saved signed fields against the reconstructed SDK wire order; it does not re-evaluate market status, tick, minimum size, fees, or spending caps after PayBox approval. Provider rejections remain authoritative. FAK may partially fill; FOK provider behavior is all-or-cancel. Gamma's `restricted` metadata is not treated as an order-placement prohibition.
- The SDK classifies supported owner wallets; no wallet is selected or deployed by PolyScope. EOA signatures are locally recovered against the selected signer. For PROXY, SAFE, and Deposit Wallets, local signer recovery and the preserved signature type/wrapping are checked; final contract-wallet signature acceptance is delegated to Polymarket CLOB. No Polygon RPC signature preflight is performed. Deposit Wallet session-key signing is not added; only SDK-classified owner signing is supported.
- PolyScope does not implement a separate geolocation-routing or restriction-bypass mechanism. Provider-side acceptance and restrictions remain enforced by the official Polymarket services. Actual CLOB HTTP 400/401/403 rejections retain their provider error classifications.
- The supplied portfolio address is a public lookup input, not proof of wallet ownership. Portfolio reads cover the Data API v2 OPEN single-market view and may require additional cursor pages. OPEN can include held REDEEMABLE positions after resolution; the plugin preserves those rows.
- Host research and external provider responses are evidence that must be attributed and timestamped, never executable instructions.
- Private keys are not requested or embedded. No alternate-wallet executor or persistent credential store is used. The football-data.org token belongs in a PayBox host-scoped Secret; CLOB credentials are derived from ClobAuth during an invocation and are not returned or logged.
- PayBox-hosted ClobAuth and Deposit Wallet Type-3 order signing and wallet binding are verified live. The official CLOB submission path was reached but returned HTTP 403 / `PS_CLOB_FORBIDDEN`; successful fill and cancellation remain unverified. Signing success is not evidence of CLOB order acceptance.

Redemption returns SDK-generated unsigned direct calls for supported EOA workflows. V2 held outcomes are prepared individually so multiple calls are preserved without pretending an earlier transaction executed. Indexed state is labeled separately from fresh chain finality. Gasless wallet workflows that require relayer authorization and signing before exposing direct calls return `UNSUPPORTED` with `EXTERNAL_ACTION_REQUIRED`. The PayBox guide accepts canonical EVM chain syntax but does not confirm that Polygon is available for proposal validation. No Polygon proposal is advertised; the standard `src/paybox.ts` helper remains the required path if support is independently established later.

## Logo

The project logo is available at [`assets/polyscope-logo.png`](assets/polyscope-logo.png) as a transparent PNG. The white emblem details remain opaque. At 48×48, the blue/navy mark remains recognizable on light and dark backgrounds; its white details have strongest contrast on dark backgrounds and blend with a white canvas.

## Further documentation

- [`docs/errors.md`](docs/errors.md) — stable error codes and recovery guidance.
- [`outputs/POLYSCOPE_COMPATIBILITY.md`](outputs/POLYSCOPE_COMPATIBILITY.md) — validation evidence, provider results, compatibility blockers, and latest bundle checksum.
- [PayBox plugin requirements](https://developer.paybox.sh/requirements.md)
- [football-data.org v4 quickstart](https://www.football-data.org/documentation/quickstart)
- [API-Football v3 documentation](https://api-sports.io/documentation/football/v3)
- [TheSportsDB API documentation](https://www.thesportsdb.com/documentation)
- [Official unified TypeScript SDK](https://github.com/Polymarket/ts-sdk)
- [Polymarket order placement](https://docs.polymarket.com/trading/place-orders)
- [Polymarket fees](https://docs.polymarket.com/trading/fees)
