# PolyScope — implementation and compatibility readiness

Checked: 2026-10-17 (Asia/Jakarta)

Runtime: official PayBox starter 1.0.2, Node.js 24.22.0, pnpm 11.11.0

Integrated base: PR #3 merge commit `0f5866cac685f860f0a79ccb1a9009812ff3b2a4` on `main`.

Decision: **PR3_MERGED; LOCAL_INTEGRATION_CHECKS_PASSED; PAYBOX_SKILL_AUTO_LOADING_UNVERIFIED; LIVE_AGENT_BROWSING_UNVERIFIED; LIVE_TRADING_UNVERIFIED**

This report records the integrated PR #3 trading implementation and PR #4 soccer research extension. The hosted acceptance rows below are historical owner-reported evidence, not a retest of this bundle. This integration performs no hosted test, wallet-signing request, order broadcast, deposit, deployment, or PR merge.

## PR #5 — multi-provider soccer research and independent edge

This branch is based on `main` at `d2c678f8b15d5cfeb7017e3b2a5ca596eb094cdf`, where PR #3 and PR #4 are already merged. The current bundle has **13 MCP tools**; the 12-tool counts and hosted observations in the historical PR #4 report below describe that older bundle, not this branch.

`research_soccer` keeps football-data.org as the baseline and optionally calls API-Football only for an exact fixture when `includeApiFootball: true`. It requests `/fixtures?date=...&timezone=UTC` and `/teams/statistics` for each provider-specific team ID, using the provider fixture's league and season and a cutoff on the UTC day before kickoff. Names, competition, and exact kickoff are checked before joining; ambiguous, missing, conflicting, or unavailable provider data does not replace baseline evidence. Three API-Football calls are made per opt-in enrichment. The official v3 documentation documents `/fixtures`, `/teams/statistics`, `/injuries`, `/fixtures/lineups`, `/fixtures/statistics`, and `/predictions`; account-specific access, competition coverage, and quota were not checked because no API-Football credential was available. The published free plan currently advertises 100 requests/day, but that is not evidence of this developer account's entitlement. `/fixtures/statistics` documents shots, possession, cards, and passes, not xG. Injuries and lineups remain host-agent/browser research topics in this implementation.

TheSportsDB free v1 was checked on 2026-10-17: `searchteams.php?t=Arsenal` and `eventslast.php?id=133604` both returned HTTP 200. The first mapped Arsenal to TheSportsDB team ID `133604`; the second returned one Arsenal home event (Arsenal vs Lille, 2026-10-13). Official docs indicate free v1 endpoint-specific limits, including one-result free team search/schedule, and that free team schedules show only home events. The free API can supply isolated supplementary metadata but is incomplete for two-team form, so PolyScope keeps it disabled rather than making calls on every research request. Premium v2 and premium endpoint limits are not assumed to be free.

`analyze_soccer_edge` is a read-only deterministic tool. It uses API-Football venue averages when both teams have sourced venue samples and goals-for/against averages; otherwise it uses the exact fixture's pre-kickoff, same-venue recent results from football-data.org. Expected home goals are `(home home GF average + away away GA average) / 2`; expected away goals are `(away away GF average + home home GA average) / 2`. Independent Poisson score probabilities are evaluated over a dynamic grid, tail mass is reported, and the included score outcomes are normalized to Home/Draw/Away. No market odds enter this model. It only evaluates a market after the agent identifies exact regulation-time 1X2 resolution semantics. The BUY edge uses `get_quote` fillable asks, weighted cost, and estimated fees: `(gross fill cost + fees) / fillable shares`, `probability - effective cost/share`, and `fillable shares × net edge/share`. Partial FAK depth limits expected value to visible fillable shares. SELL economics, non-1X2 resolution rules, and missing model data are reported unsupported or unavailable; no trading gate is introduced.

PayBox automatic loading of repository `SKILL.md` files and hosted agent browsing remain **UNVERIFIED**. API-Football's `x-apisports-key` and football-data.org's `X-Auth-Token` are intended to use PayBox host-scoped secrets, but hosted secret injection was not verified. No live Polymarket submission or wallet signing was performed. The hosted PayBox `primaryType: undefined` signing-window issue remains outside this change.

Final Node/pnpm validation and bundle checksum for this branch are recorded below after the PR #5 implementation is built.

## PayBox hosted acceptance evidence

The project owner reports the following results from the private PayBox Developer Dashboard and connected agent:

| Check | Result | Scope |
|---|---|---|
| Hackathon submission | `Submitted` | Submission status only; not evidence of public listing or trading. |
| PolyScope plugin | `Enabled privately` | Enabled for the owner's account; not publicly listed. |
| Tool discovery | `PASS` — 12 tools discovered | Confirms the hosted plugin registered its 12 tools. |
| Agent-invoked `search_markets` | `PASS` | Market discovery tool invocation. |
| Agent-invoked `get_quote` | `PASS` | Quote tool invocation; not an order submission. |
| Agent-invoked `research_soccer` | `PASS` | Soccer research tool invocation. |
| Developer Dashboard `prepare_clob_auth` | `PASS` | Payload preparation only; no wallet signature was verified. |
| Developer Dashboard `prepare_order_signing` | `PASS` | Order payload preparation only; no wallet signature was verified. |

**Still `UNVERIFIED`:** hosted wallet credential selection and `request_wallet_sign` read-back, wallet binding from a real signature, authenticated Polymarket CLOB L1/L2 access, real BUY/SELL submission, and order/fill read-back. Passing payload-preparation tools does not prove signing or trading compatibility.

## Implemented scope

The plugin keeps the approved four stages: public live data and news → PayBox agent research → explicit user decision → PayBox authorization and Polymarket order submission. There is no scheduler, deterministic strategy engine, Combo, Parlay, RFQ, or multi-leg order flow.

| Tool | Behavior |
|---|---|
| `search_markets` | Searches active Gamma markets and maps each outcome to its CLOB asset/position ID. |
| `get_quote` | Reads a CLOB book, bounded depth, fillability, market fee descriptor, fee estimate, and informational freshness. |
| `get_soccer_news` | Reads ESPN RSS and returns only stories whose text names a requested team, with source/publication/observation times; content is marked untrusted. |
| `research_soccer` | Reads football-data.org PL, PD, SA, and CL fixtures/results and every available recent result, with per-team counts and `COMPLETE_LAST_5`, `PARTIAL`, or `UNAVAILABLE` coverage. Missing API topics are research gaps; the tool description directs the host agent to continue with its browser/search tools. The repository skill covers match context, xG/xGA, injuries, suspensions, lineups, sources, and uncertainty. |
| `prepare_clob_auth` | Prepares the official Polygon ClobAuth EIP-712 payload for an existing signer. |
| `validate_clob_auth_signature` | Recovers and checks the ClobAuth signer against the supplied signer address. |
| `prepare_order_signing` | Prepares one selected-outcome FAK BUY or SELL and returns one Polymarket Order typed-data intent. BUY `priceLimit` is the maximum; SELL `priceLimit` is the minimum. Signed maker/taker amounts encode the chosen price and exact share size. Book age is informational and has no 120-second cutoff. |
| `validate_order_signature` | Rebuilds the Polymarket order, checks exact amount precision and fee-inclusive cap, recovers the selected signer locally, and constructs the Deposit Wallet ERC-7739 wrapper. Smart-wallet contract acceptance is deferred to CLOB; no Polygon RPC validation is claimed. |
| `submit_fak_order` | Validates the Polymarket order and ClobAuth signatures, live market identity and exchange constraints, current fee-inclusive cap, and official geoblock, then makes one FAK POST attempt. Polymarket handles account, balance, allowance, and exchange acceptance. An ambiguous response gets one read-only order-hash reconciliation and is never automatically resubmitted. |
| `get_order_status` | Reads authenticated order/fill state. A positive matched amount takes precedence over a cancelled FAK remainder and is reported as `PARTIALLY_FILLED` or `FILLED`. |
| `cancel_order` | Sends an explicit cancellation request and reads order state if the result is ambiguous. |
| `get_portfolio` | Reads one Polymarket Data API v2 `/v2/positions?status=OPEN` page with snake_case rows and `{data, pagination}`. Returns `complete: false` while more cursor pages remain; `complete: true` covers only the full OPEN single-market view, not closed positions or combos. The caller passes `nextCursor` to continue. The supplied address is labeled `PUBLIC_ADDRESS_UNVERIFIED`, not proof of wallet ownership. |

The portfolio response follows Polymarket's documented v2 envelope, cursor pagination, snake_case fields, and `/v2/positions` route; no v1 fallback is used. [Data API v2 positions and response schema](https://data-api.polymarket.com/v2/docs) · [Data API v1-to-v2 migration](https://docs.polymarket.com/migrate/data-api-v1-to-v2)

Polymarket documents FAK with a maximum BUY price or minimum SELL price. The official `maxSpend` model can reduce the signed BUY amount to fit a fee-inclusive cap, but that resizing conflicts with PolyScope's selected exact share size and externally produced PayBox signature. PolyScope therefore preserves signed price and size and rejects preparation/submission if current fees would exceed the user's all-in cap. [Place Orders](https://docs.polymarket.com/trading/place-orders) · [Fees](https://docs.polymarket.com/trading/fees)

## Provider results and coverage

| Provider | Local result | What this proves |
|---|---|---|
| Polymarket Gamma | `AVAILABLE` | Current sample market search returned valid active market/outcome data. |
| Polymarket CLOB | `AVAILABLE`, `STALE` | Current conformance observed a 97,392 ms book; unsigned preparation succeeded and did not submit an order. Quote freshness is informational for execution. |
| ESPN RSS | `AVAILABLE` | Team-filtered soccer headlines and source timestamps were returned. This is not a verified injury or lineup feed. |
| football-data.org direct API diagnostic | The developer previously reported authenticated HTTP 200 checks on 2026-10-17: PL 5 fixtures, PD 4, SA 3, CL 0. | Historical direct API access only; HTTP 200 with zero fixtures is not an authentication failure. The check was not repeated during this integration and does not prove PayBox-hosted secret injection. |
| `pnpm conformance` soccer calls | `UNAVAILABLE` for PL, PD, SA, and CL; each call returned HTTP 403 because the local runner has no PayBox host-scoped secret injection. | The offline/runtime harness correctly reports missing local credentials. The direct token diagnostic above is separate and is not a hosted PayBox test. |

The prior four-competition check is historical provider evidence only. PolyScope requests numeric competition ID, `status=FINISHED`, and `limit=100`, then independently filters exact competition ID, finished status, and kickoff earlier than the selected fixture. No season identifier is inferred when the API does not supply one; `coverage` describes only returned matches in the requested date window. HTTP 403 and 429 remain distinct provider errors. The API uses `X-Auth-Token`. [Coverage](https://www.football-data.org/coverage) · [Pricing and rate limits](https://www.football-data.org/pricing) · [API authentication examples](https://docs.football-data.org/general/v4/coding_client.html)

The v4 quickstart and official lookup map PL/PD/SA/CL to `2021`/`2014`/`2019`/`2001`. Provider HTTP errors remain status-specific and do not include response bodies or tokens. [Team Match API reference](https://docs.football-data.org/general/v4/team.html) · [v4 quickstart filter reference](https://www.football-data.org/documentation/quickstart) · [Official competition lookup table](https://docs.football-data.org/general/v4/lookup_tables.html)

The deterministic offline suite uses isolated fixtures to validate mapping and numeric team-form filters for all four competitions, client-side filtering of mixed competitions/statuses/kickoff times, 5/5, 5/4, 5/0, and 0/0 form handling, and safe 403/429 diagnostics. Those fixtures are test data, not provider-coverage evidence. TheSportsDB is removed from the current path; its known disabled free API was not debugged again.

The generic market search and order tools use a single selected Polymarket CLOB market/outcome. Crypto, weather, soccer, politics, and finance are discoverable through the same market-data path when a corresponding active CLOB market exists. There are no specialized weather/xG/injury datasets or combo/multi-leg tools.

## PayBox signing and stateless runtime compatibility

**PayBox automatic skill loading: UNVERIFIED.** The public PayBox plugin README lists its packaged skills but does not specify that a connected host automatically loads arbitrary repository `SKILL.md` files. PolyScope therefore also puts browser-continuation instructions in both MCP tool descriptions. That fallback is verified in the built tool catalog; it does not prove live agent browsing.

`requestWalletSignIntent: { op: "typedData", typedData }` carries the Polymarket Order intent. PayBox's official MCP flow uses `request_wallet_sign`, surfaces any required passkey approval, and polls `get_request` until the signing window returns its signature. ClobAuth is a distinct Polymarket L1 authentication operation used to derive CLOB L2 credentials; it is not another PolyScope approval. Order signatures are checked against the selected signer and wallet type. Deposit Wallet preparation uses the documented `TypedDataSign` envelope and ERC-7739 wrapper path. [PayBox request lifecycle](https://docs.paybox.sh/concepts/requests) · [PayBox MCP tools](https://docs.paybox.sh/reference/mcp-tools)

**Remaining PayBox blocker:** the repo's reported PayBox signing-window failure (`primaryType` is `undefined`) is outside this adapter and is not fixed by this refactor. The official docs define the MCP request and polling flow, but this task does not exercise the hosted window, the real PayBox credential binding, or ERC-1271 acceptance. Offline fixtures use generated test keys only.

For each submit/status/cancel operation, the plugin derives or creates Polymarket L2 credentials from the supplied ClobAuth signature, uses them only for that invocation, and never returns or logs credentials. No persistent storage or alternate wallet is used. Preflight runs the four public reads (Gamma market, CLOB book, fee metadata, and geoblock) concurrently with CLOB credential derivation. Per-request timeouts remain bounded at 2.5 seconds for public reads and 1.5 seconds for authenticated CLOB/RPC requests; the FAK POST and optional single reconciliation each have a 1.5-second request timeout. There is no custom total trading budget; the PayBox host/tool deadline applies. A timeout after a potentially accepted POST returns `UNKNOWN` and never triggers another POST.

Polymarket documents ClobAuth, L2 credential derive/create endpoints, wallet signature types, and Deposit Wallet typed-data form. PolyScope uses those documented shapes. [Wallets and Authentication](https://docs.polymarket.com/trading/wallets-auth) · [Place Orders and Deposit Wallet typed data](https://docs.polymarket.com/trading/place-orders)

## Preconditions and operational boundaries

- The source makes no `process.env` reads. No environment variables are required.
- Add these exact HTTPS hostnames to the PayBox portal allowlist:
  - `gamma-api.polymarket.com`
  - `clob.polymarket.com`
  - `data-api.polymarket.com`
  - `polymarket.com`
  - `api.football-data.org`
  - `www.espn.com`
- Configure the developer-owned football-data.org API token as a PayBox brokered **Secret** scoped to hostname `api.football-data.org`, header `X-Auth-Token`. Do not place the token in source, sample arguments, environment output, or the bundle. It is needed for soccer API access only.
- CLOB trading requires an existing Polymarket wallet/account with sufficient pUSD or outcome-token balance and exchange allowance. Polymarket validates these account conditions at order submission; PolyScope does not refresh local balance/allowance before every order, deposit, create wallets, or submit approval transactions.
- The geoblock preflight checks Polymarket's request location as seen from the hosted PayBox egress IP. It fails closed when blocked or unavailable and is not evidence of user eligibility; CLOB remains the final enforcement point. No bypass is used.
- Invalid credentials or signatures, wallet mismatch, missing fee descriptor, invalid market identity/status, changed exchange constraints, a cap overrun, provider geoblock, or CLOB rejection prevents acceptance. A quote marked `STALE` and a preparation older than 120 seconds are informational and are not independent blockers. No fallback wallet or silent amount/order-type change exists.

### Eligibility metadata and hosted schema compatibility

The Gamma API schema and Polymarket's market-data reference describe market discovery metadata and CLOB order-book fields, but do not define Gamma's `restricted` value as an order-placement prohibition. PolyScope therefore does not expose that value as a trading eligibility flag or reject execution based on it alone. Execution still checks market identity, active/closed/accepting-orders status, CLOB availability and exchange constraints, and the official geoblock response; a blocked geoblock response continues to fail closed. [Gamma API OpenAPI schema](https://gamma-api.polymarket.com/docs) · [Polymarket market-data reference](https://github.com/Polymarket/agent-skills/blob/main/market-data.md)

The strict PayBox schemas have these compatibility changes: `marketRestricted` is removed from search, quote, and prepared-order market objects; `accountGeoblockChecked` is removed from quote; `executionApprovalSigningIntent` is removed from PREPARED output; and `executionApprovalSignature` is removed from `submit_fak_order` input. `preparationFreshness` changes from `{ bookAgeMs, staleAfterMs }` to `{ bookAgeMs }`. Old hosted strict schemas will reject new outputs or the new submit input, and the new strict submit schema rejects the removed approval-signature field. Refresh the hosted plugin registration after review. `preparedOrder.market.bookTimestamp` and preparation age are not part of the signed EIP-712 order; deterministic signature checks verify the signature remains valid when that metadata changes. The Polymarket Order EIP-712 fields and digest construction remain unchanged.

### Local trading rejection audit

`docs/errors.md` classifies actual trade-path rejections as official Polymarket requirements, exact user-approved order constraints, or redundant/custom PolyScope policy. It lists provider and transport failures separately because they are operational errors, not eligibility policy. There is no local ERC-1271 RPC preflight. Smart-wallet signer recovery and Deposit Wallet wrapping remain local; CLOB determines contract-wallet acceptance.

The official [API authentication guide](https://docs.polymarket.com/getting-started/api#authentication) requires a current Unix-seconds timestamp in ClobAuth but specifies no 300-second acceptance window. The [wallets and authentication guide](https://docs.polymarket.com/trading/wallets-auth) likewise gives no age limit. The local 300-second rejection was removed; signer recovery remains, and CLOB credential derivation is authoritative for timestamp acceptance. The official [Order format](https://docs.polymarket.com/trading/place-orders) includes a signed Unix-millisecond timestamp without a five-second future tolerance; that local cutoff was removed while retaining positive safe-integer encoding. Book timestamps, including slightly future or unparseable freshness values, are informational only.

At submission the exact signed price is checked against the current tick, and exact signed share size against the current minimum. Changed tick/minimum metadata proceeds when the existing order remains valid and rejects only when that exact order violates the current rule. Exchange version and neg-risk mode remain checked because they determine signing-domain compatibility. No order is modified or re-signed.

### Signing workflow, request count, and latency

| Stage | Before | After |
|---|---|---|
| Signing | PayBox Order + ClobAuth signatures plus a custom PolyScope `ExecutionApproval` signature | PayBox handles human approval and the official Polymarket Order signature; ClobAuth remains only for CLOB L1/L2 authentication |
| Freshness | 120-second preparation cutoff and 30-second submission rejection | Book age remains visible; the signed BUY maximum / SELL minimum and FAK semantics bound execution |
| Preflight | Four concurrent market/book/fee/geoblock reads, ClobAuth derivation, then close-only plus balance refresh/read | Four concurrent market/book/fee/geoblock reads and ClobAuth derivation; CLOB handles balance, allowance, account and exchange acceptance |
| Total submit requests | 9 requests on derived credentials, or 10 if L1 credential creation is needed | 6 requests on derived credentials, or 7 if L1 credential creation is needed |
| Total prepare + submit | 12 requests, or 13 with L1 credential creation | 9 requests, or 10 with L1 credential creation |

The request counts exclude PayBox's external wallet-sign request; ambiguous submission adds one read-only CLOB reconciliation in either version. The reduction removes three authenticated account reads and one redundant Polygon RPC signature preflight for smart wallets. Preparation still makes three parallel reads (Gamma market, CLOB book, CLOB fee metadata). Submission makes its four provider reads concurrently with L1 credential derivation. Public requests have a 2.5-second timeout; authenticated CLOB calls have a 1.5-second timeout. The normal timeout envelope is about 4 seconds (2.5-second parallel preflight + 1.5-second POST), or 4.5 seconds if credential creation follows a derive miss. An ambiguous POST can add one 1.5-second reconciliation. These are timeout envelopes, not measured latency promises. There is no custom overall budget; the PayBox host/tool deadline governs.

### Hosted schema compatibility

`validate_order_signature` keeps its tool name and input shape but changes its strict output: `valid` is replaced with `localSignerVerified`, and `onchainWalletValidation` is replaced with `contractWalletAcceptance` (`NOT_APPLICABLE` or `DEFERRED_TO_CLOB`). Hosted consumers that validate the previous strict result schema must update. The result no longer implies that an ERC-1271 call occurred. Quote and prepared-order `bookTimestamp` fields now accept `null` when the provider omits its informational timestamp; hosted consumers that assume a non-null string should allow null. No other tool is added or removed; the interface remains 12 tools. Existing PayBox host allowlists may remove `polygon-rpc.com`, which PolyScope no longer calls.

The official `@polymarket/client` package is Node 24 compatible, but its documented order examples build and sign through a configured signer. The current adapter must return unsigned EIP-712 data for PayBox's separate signing window and preserve the user's exact share size. The official `maxSpend` model reduces the signed BUY amount, so using that resizer would alter the selected share size; PolyScope instead checks the current fee against the all-in cap and rejects an over-cap exact order. The adapter remains minimal and does not add the SDK dependency. [Official TS SDK](https://github.com/Polymarket/ts-sdk) · [SDK limit-order example](https://github.com/Polymarket/ts-sdk/blob/main/examples/scripts/src/create-limit-order.ts) · [Order placement and `maxSpend`](https://docs.polymarket.com/trading/place-orders)


## Changed files

- `README.md` — documents partial soccer coverage, browser continuation, historical provider-check scope, and merged PR #3.
- `skills/polyscope-soccer-research/SKILL.md` — guides API-first match research with host-native browser continuation.
- `src/plugin.ts` — removes the separate Polygon RPC ERC-1271 preflight; distinguishes locally recovered signer from deferred CLOB smart-wallet acceptance; checks exact signed price/size against current tick/minimum without rejecting metadata changes alone; keeps exchange version/risk compatibility and ignores book timestamp for eligibility.
- `scripts/conformance.mjs` — keeps PR #3 trading regressions and adds PR #4 browser-continuation, soccer mapping, partial-form, source-error, and skill-text regressions.
- `tests/network-fixtures.mjs` — deterministic trading, CLOB, Gamma, geoblock, credential, smart-wallet, metadata-drift, POST, soccer coverage, and provider-error fixtures; no real signing or live order is performed.
- `docs/errors.md` — stable error codes, retry guidance, user-facing explanations, and safe football provider HTTP/network failure behavior.
- `outputs/POLYSCOPE_COMPATIBILITY.md` — this report.
- `outputs/plugin.mjs` — distributable copy of the built artifact.

The official 1.0.2 starter layout and pinned package manifest/lockfile were preserved; no backend, database, CLI, persistent state service, or new runtime dependency was added in this implementation update.

## Local validation

Toolchain used: Node.js `24.22.0`, pnpm `11.11.0`.

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS — Node.js 24.22.0 and pnpm 11.11.0; lockfile unchanged and dependencies already current |
| `pnpm typecheck` | PASS — `tsc --noEmit` |
| `pnpm test` | PASS — TypeScript check, two deterministic builds, and offline regression suite. Covered PR #3 trading behavior and soccer 5/5, 5/4, 5/0, 0/0, 403/429, host-tool description, and skill-guidance cases. No live order submission. |
| `pnpm conformance` | PASS — public market/news/quote reads and unsigned preparation succeeded; quote age was 97,392 ms (`STALE`). PL, PD, SA, and CL returned HTTP 403 without a local football-data.org secret. Tool catalog: exactly 12. Both soccer tool descriptions contain browser continuation instructions; active MCP schemas omit removed trading-policy fields. |
| `pnpm build` | PASS — two consecutive builds were byte-identical; `dist/plugin.mjs` and tracked `outputs/plugin.mjs` match (575,421 bytes, SHA-256 `eea82bd4a418a30a8f8a4d86e8c13710f8d8270f504c05d6078cdc9c9b222819`). |
| `pnpm audit --prod` | PASS — no known production dependency vulnerabilities reported |
| `git diff --check` | PASS after source, report, and bundle updates |


Offline cases include exact BUY/SELL signed price and share amounts, one valid EOA and one valid Deposit Wallet FAK order POST intercepted without ExecutionApproval or Polygon RPC, local invalid signer rejection, changed min/tick cases that proceed or reject by exact signed constraints, zero current minimum rejection, risk-mode incompatibility, informational stale/future/malformed/missing book timestamps, no-visible-liquidity preparation, 301-second ClobAuth age, future signed Order timestamp, fee-inclusive caps (including changed fees), `restricted=true`, blocked geoblock, missing CLOB credentials, one-time ambiguous POST reconciliation, Deposit Wallet ERC-7739 wrapping, team attribution, all four deterministic competition mappings and numeric team-form filters, complete/incomplete form handling, safe HTTP 403/429 diagnostics, provider failure handling, portfolio pagination, and 12-tool registration. Local signatures use generated test-only keys; fixture credentials and POSTs are not live CLOB evidence.

**Not covered locally:** PayBox signing-window `primaryType` behavior and wallet binding, real ERC-1271 acceptance by CLOB, authenticated L2 credentials, live balance/allowance/geoblock behavior, real fills, status read-back, cancellation, or real ambiguous-POST reconciliation. The fixture demonstrates adapter behavior only; no live signature or trade was requested.

Current public conformance returned an AVAILABLE CLOB quote marked STALE at 97,392 ms and prepared the unsigned order without submitting. Soccer calls returned HTTP 403 because this runner has no local provider secret. The developer-reported authenticated provider check from 2026-10-17 (PL 5, PD 4, SA 3, CL 0) was not repeated; HTTP 200 with zero fixtures is not an authentication failure. Neither check proves PayBox-hosted secret injection.

## Artifact

- Path: `dist/plugin.mjs` (matching tracked copy at `outputs/plugin.mjs`)
- Size: **575,421 bytes** (562 KiB; below 10 MiB)
- SHA-256: `eea82bd4a418a30a8f8a4d86e8c13710f8d8270f504c05d6078cdc9c9b222819`

## Readiness decision and next gate

**Hosted PayBox Marketplace BUY/SELL: NOT PROVEN. PayBox automatic loading of this repository skill: UNVERIFIED. Live host-agent browser research: UNVERIFIED.** The source contains a FAK order path that performs the documented Polymarket checks and submission contract, but no authenticated order or fill was attempted. The latest local quote was marked stale and preparation succeeded; live trading remains unverified. Soccer calls returned 403 without local PayBox secret injection. PayBox's signing-window `primaryType` blocker, real wallet signing, and authenticated CLOB BUY/SELL have not been exercised. PayBox-hosted signing and CLOB execution remain unverified; any order still follows PayBox's normal approval and signing flow.

The tracked bundle was rebuilt in this PR and was not uploaded to hosted PayBox. No live signature, order broadcast, deposit, deployment, merge, or project resubmission was performed. The `Submitted` status above is the project owner's reported hackathon status, not an action taken in this update.

## PR #5 branch validation

Toolchain used for this branch: Node.js `24.19.0`, pnpm `11.11.0`.

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS — lockfile unchanged; dependencies already current |
| `pnpm typecheck` | PASS — `tsc --noEmit` |
| `pnpm test` | PASS — two deterministic builds, strict typecheck, all PR #3 trading regressions, PR #4 soccer regressions, API-Football normalization/error fixtures, Poisson source/fallback cases, and CLOB net-edge cases |
| `pnpm conformance` | PASS — 13 tools discovered; public market/news/quote reads and unsigned preparation succeeded. football-data.org returned HTTP 403 for PL/PD/SA/CL without a local token. CLOB quote was STALE at 61,334 ms. No order was submitted. |
| `pnpm build` twice | PASS — byte-identical output; `dist/plugin.mjs` and `outputs/plugin.mjs` match exactly |
| `pnpm audit --prod` | PASS — no known production dependency vulnerabilities reported |
| `git diff --check` | PASS |

Offline provider coverage includes API-Football HTTP 403/204, HTTP 200 error envelope, missing or malformed stats, provider ID mismatch, kickoff conflict, ambiguous duplicate, and preservation of football-data.org evidence. Model cases cover source attribution, venue samples, normalization, unavailable inputs, positive/negative edges, depth-weighted price, fees, partial fill, no liquidity, unsupported rules, and unsupported SELL basis. They are deterministic fixture evidence, not prediction-accuracy or live-provider claims.

The built bundle contains **13 MCP tools**, including the read-only `analyze_soccer_edge`. Both existing soccer tools retain host-browser continuation instructions. Active tool schemas contain no removed PR #3 trading policy fields or extra signing requirements.

Current `outputs/plugin.mjs` and `dist/plugin.mjs` size is **593,288 bytes**. SHA-256 is `3b6b9a5b6cc7672888755e4e372f13aa7e90f3e74f537fd7b53abc5c8eab6c97` for both files. PayBox skill auto-loading, host-scoped secret injection, live agent browsing, API-Football account entitlement, and hosted wallet signing remain unverified.
