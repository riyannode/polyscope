# PolyScope — implementation and compatibility readiness

Checked: 2026-10-17 (Asia/Jakarta)

Runtime: official PayBox starter 1.0.2, Node.js 24.22.0, pnpm 11.11.0

Decision: **LOCAL_CHECKS_PASSED; HOSTED_TRADING_COMPATIBILITY_NOT_PROVEN**

This report records local implementation and public-network checks. No PayBox hosted test, wallet-signing request, order broadcast, deposit, deployment, merge, or submission was performed.

## Implemented scope

The plugin keeps the approved four stages: public live data and news → PayBox agent research → explicit user decision → PayBox authorization and Polymarket order submission. There is no scheduler, deterministic strategy engine, Combo, Parlay, RFQ, or multi-leg order flow.

| Tool | Behavior |
|---|---|
| `search_markets` | Searches active Gamma markets and maps each outcome to its CLOB asset/position ID. |
| `get_quote` | Reads a fresh CLOB book, bounded depth, fillability, market fee descriptor, and fee estimate. |
| `get_soccer_news` | Reads ESPN RSS and returns only stories whose text names a requested team, with source/publication/observation times; content is marked untrusted. |
| `research_soccer` | Reads football-data.org PL, PD, SA, and CL fixtures/results. Team-form requests use numeric competition IDs PL `2021`, PD `2014`, SA `2019`, and CL `2001`. Exact fixture requests include last five completed results only when all five for both teams are present. xG, injuries, and lineups are `UNAVAILABLE`. |
| `prepare_clob_auth` | Prepares the official Polygon ClobAuth EIP-712 payload for an existing signer. |
| `validate_clob_auth_signature` | Recovers and checks the ClobAuth signer against the supplied signer address. |
| `prepare_order_signing` | Prepares one selected-outcome FAK BUY or SELL and separate typed-data intents for the order and explicit execution approval. BUY `priceLimit` is the user’s maximum; SELL `priceLimit` is the minimum. The approval binds the exact EIP-712 order hash, signing address, price, size, fee parameters, fee-inclusive cap, wallet signature type, FAK, and deadline. The maker and order amounts are committed by the Polymarket order hash. |
| `validate_order_signature` | Rebuilds the approved order, checks the fee-inclusive cap, recovers the signer, constructs the Deposit Wallet ERC-7739 wrapper, and calls Polygon RPC for ERC-1271 validation on smart wallets. |
| `submit_fak_order` | Revalidates approval/signatures, market/book/fee, geo and account state, balance and exchange allowance, then makes one FAK POST attempt per tool invocation. A successful HTTP response returns `SUBMITTED`; it does not claim a fill. An ambiguous response gets at most one bounded read-only order-hash reconciliation and remains `UNKNOWN` unless authoritative order state is found. There is no automatic resubmit or exactly-once guarantee. |
| `get_order_status` | Reads authenticated order/fill state. A positive matched amount takes precedence over a cancelled FAK remainder and is reported as `PARTIALLY_FILLED` or `FILLED`. |
| `cancel_order` | Sends an explicit cancellation request and reads order state if the result is ambiguous. |
| `get_portfolio` | Reads one Polymarket Data API v2 `/v2/positions?status=OPEN` page with snake_case rows and `{data, pagination}`. Returns `complete: false` while more cursor pages remain; `complete: true` covers only the full OPEN single-market view, not closed positions or combos. The caller passes `nextCursor` to continue. The supplied address is labeled `PUBLIC_ADDRESS_UNVERIFIED`, not proof of wallet ownership. |

The portfolio response follows Polymarket's documented v2 envelope, cursor pagination, snake_case fields, and `/v2/positions` route; no v1 fallback is used. [Data API v2 positions and response schema](https://data-api.polymarket.com/v2/docs) · [Data API v1-to-v2 migration](https://docs.polymarket.com/migrate/data-api-v1-to-v2)

Polymarket documents FAK as a supported market order, with a maximum BUY price or minimum SELL price; fee-inclusive BUY budgets must account for fees charged on top of notional. PolyScope binds the chosen `FAK` type and bounds into the separately signed execution approval and preserves it in the CLOB request. [Place Orders](https://docs.polymarket.com/trading/place-orders) · [Fees](https://docs.polymarket.com/trading/fees)

## Provider results and coverage

| Provider | Local result | What this proves |
|---|---|---|
| Polymarket Gamma | `AVAILABLE` | Current sample market search returned valid active market/outcome data. |
| Polymarket CLOB | `AVAILABLE`, `STALE` | The latest conformance quote book age was 141,342 ms, above the 30-second limit. Order preparation was correctly skipped for that stale book. |
| ESPN RSS | `AVAILABLE` | Team-filtered soccer headlines and source timestamps were returned. This is not a verified injury or lineup feed. |
| football-data.org | `UNAVAILABLE` for PL, PD, SA, and CL; each local request returned HTTP 403 with a safe access/plan-permission reason | No local fixture, result, or form coverage is claimed. The local runner has no configured provider token. The hosted report that PL fixtures worked proves fixture access only; form remains unverified. |

football-data.org currently lists the Premier League, LaLiga, Serie A, and Champions League under its Free Tier, and the registered Free plan lists fixtures, delayed scores/schedules, league tables, and 10 calls per minute. The provider separately lists advanced trend/form data under ML Pack Light. PolyScope derives its last-five record from team-match results, but the free-tier entitlement for that history endpoint has not been confirmed for the developer's token. Each exact fixture lookup uses one fixture request plus two team-history requests. The API uses the `X-Auth-Token` header. This supports choosing the provider but does not prove that a configured token has permission to retrieve the needed history. [Coverage](https://www.football-data.org/coverage) · [Pricing and rate limits](https://www.football-data.org/pricing) · [API authentication examples](https://docs.football-data.org/general/v4/coding_client.html)

The v4 quickstart documents `competitions` as a comma-separated numeric competition-ID filter; the official lookup table maps the four supported leagues to the IDs above. The lookup table also says league codes may be used as aliases for IDs, so a prior `PL` filter is not by itself proven to explain the hosted `UNAVAILABLE` result. PolyScope now sends numeric IDs as requested. A 403 can still indicate token, competition, resource, or plan permissions; 401, 429, and other statuses are reported distinctly without returning provider response bodies or tokens. [v4 quickstart filter reference](https://www.football-data.org/documentation/quickstart) · [Official competition lookup table](https://docs.football-data.org/general/v4/lookup_tables.html)

The deterministic offline suite uses isolated fixtures to validate mapping and numeric team-form filters for all four competitions, complete/incomplete form handling, and safe 403/429 diagnostics. Those fixtures are test data, not provider-coverage evidence. TheSportsDB is removed from the current path; its known disabled free API was not debugged again.

The generic market search and order tools use a single selected Polymarket CLOB market/outcome. Crypto, weather, soccer, politics, and finance are discoverable through the same market-data path when a corresponding active CLOB market exists. There are no specialized weather/xG/injury datasets or combo/multi-leg tools.

## PayBox signing and stateless runtime compatibility

The tools return `requestWalletSignIntent: { op: "typedData", typedData }` for ClobAuth, the Polymarket order, and PolyScope’s separate user execution approval. The connected PayBox agent must select its existing wallet credential, submit each applicable signing request through its native `request_wallet_sign`, poll `get_request`, and pass the returned signature to the matching plugin tool. The signed EOA is recovered against the supplied address; wallet-type, maker, signer, chain, and signature-type relationships are checked. Deposit Wallet preparation uses the documented `TypedDataSign` envelope and ERC-7739 wrapper path.

**Blocker:** the supplied PayBox plugin guide does not define a plugin-callable `request_wallet_sign` contract or document the exact native tool input/output schema. The plugin cannot invoke another agent tool itself. The agent-to-plugin orchestration and actual PayBox credential binding therefore remain unverified until a hosted read-only/signing check is approved. Offline tests cover typed-data construction, invalid-signature rejection, and Deposit Wallet payload shape, but not a valid credential signature or live ERC-1271 acceptance.

For each submit/status/cancel operation, the plugin derives or creates Polymarket L2 credentials from the supplied ClobAuth signature, uses them only in that invocation for HMAC-authenticated requests, and never returns or logs the API key, secret, passphrase, or private key. No persistent storage or alternate wallet is used. A submit invocation has a 7-second monotonic callback budget, leaving 3 seconds of the PayBox 10-second ceiling for host startup and response overhead. Every submit preflight request shares that deadline and preserves 3.5 seconds for the FAK POST, one possible reconciliation, and a small tail margin. The POST and reconciliation requests have separate bounded deadlines. If preflight cannot preserve that window, it returns `PS_EXECUTION_BUDGET_EXHAUSTED` before the order POST. After an ambiguous POST, one read-only reconciliation is attempted only if time remains; otherwise the result is `UNKNOWN`, with no automatic retry. Offline fixtures verify the pre-POST stop. The 3-second startup/response reserve and the PayBox host's actual cold-start timing remain unverified until hosted acceptance.

Polymarket documents ClobAuth, L2 credential derive/create endpoints, wallet signature types, and Deposit Wallet typed-data form. PolyScope uses those documented shapes. [Wallets and Authentication](https://docs.polymarket.com/trading/wallets-auth) · [Place Orders and Deposit Wallet typed data](https://docs.polymarket.com/trading/place-orders)

## Preconditions and operational boundaries

- The source makes no `process.env` reads. No environment variables are required.
- Add these exact HTTPS hostnames to the PayBox portal allowlist:
  - `gamma-api.polymarket.com`
  - `clob.polymarket.com`
  - `data-api.polymarket.com`
  - `polymarket.com`
  - `polygon-rpc.com`
  - `api.football-data.org`
  - `www.espn.com`
- Configure the developer-owned football-data.org API token as a PayBox brokered **Secret** scoped to hostname `api.football-data.org`, header `X-Auth-Token`. Do not place the token in source, sample arguments, environment output, or the bundle. It is needed for soccer API access only.
- CLOB trading requires an existing Polymarket wallet/account with sufficient pUSD or outcome-token balance and exchange allowance. PolyScope only checks balance/allowance; it does not deposit, create wallets, or submit approval transactions.
- The geoblock preflight checks Polymarket's request location as seen from the hosted PayBox egress IP. It fails closed when blocked or unavailable and is not evidence of user eligibility; CLOB remains the final enforcement point. No bypass is used.
- A missing/invalid credential, wallet mismatch, unsupported wallet signature, missing fee descriptor, stale book, closed/changed market, insufficient balance/allowance, geoblock, or timeout blocks submission. No fallback wallet or silent amount/order-type change exists.

## Changed files

- `src/plugin.ts` — exact order-hash and signer approval binding, bounded FAK submit/reconciliation budget, egress-IP geoblock wording, and v2 cursor-paginated OPEN positions.
- `scripts/conformance.mjs` — approval replay, no-POST budget exhaustion, representative portfolio pagination, and numeric team-form filter/status regressions.
- `tests/network-fixtures.mjs` — representative Data API v2 rows and pagination plus offline-only request timing, numeric competition filters, and safe 403/429 fixtures; not live CLOB credentials or trade evidence.
- `docs/errors.md` — stable error codes, retry guidance, user-facing explanations, and safe football provider HTTP/network failure behavior.
- `outputs/POLYSCOPE_COMPATIBILITY.md` — this report.
- `outputs/plugin.mjs` — distributable copy of the built artifact.

The official 1.0.2 starter layout and pinned package manifest/lockfile were preserved; no backend, database, CLI, persistent state service, or new runtime dependency was added in this implementation update.

## Local validation

Toolchain used: Node.js `24.22.0`, pnpm `11.11.0`.

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS — frozen lockfile unchanged; already up to date |
| `pnpm typecheck` | PASS — `tsc --noEmit` |
| `pnpm test` | PASS — deterministic build and 21 offline cases; includes numeric PL/PD/SA/CL team-form filters and safe 403/429 diagnostics; no live order submission |
| `pnpm conformance` | PASS — market/news/quote reads succeeded; live quote was stale and FAK preparation was skipped. PL, PD, SA, and CL requests returned HTTP 403 and were reported `UNAVAILABLE` with a safe permission/plan reason. |
| `pnpm audit --prod` | PASS — no known production dependency vulnerabilities reported |
| `git diff --check` | PASS after source, report, and bundle updates |

Offline cases include BUY/SELL FAK, fee-inclusive cap and exact order-hash/signing-address approval binding, rejection of approval replay with a different salt or signer, slow preflight stopping before FAK POST without enough time reserved for reconciliation, official market fee descriptor math, invalid approval/order signature rejection, Deposit Wallet typed-data envelope, stale-book rejection, wrong outcome rejection, team attribution, all four deterministic competition mappings and numeric team-form filters, complete/incomplete form handling, safe HTTP 403 permission and 429 rate-limit diagnostics, provider failure handling, representative Data API v2 position rows and cursor pagination completeness, public portfolio address labeling, and tool registration without order submission. Local signatures use generated test-only keys; credential/account transport fixtures are not authenticated CLOB evidence or a successful trade.

**Not covered locally:** PayBox `request_wallet_sign` handoff and wallet binding, actual EOA/Proxy/Safe/Deposit Wallet account binding, successful ERC-1271 validation, authenticated L2 credential derivation, live balance/allowance/geoblock behavior, partial-fill read-back, cancellation, or ambiguous POST reconciliation. These require hosted PayBox behavior and/or authenticated CLOB responses; local transport fixtures do not establish them. They remain release gates, not passing test claims.

The last public CLOB book was 141,342 ms old, so the conformance harness skipped order preparation rather than use stale data. Market/news/quote read checks still passed. Public football-data.org requests returned 403 for all four leagues; no soccer coverage is claimed.

## Artifact

- Path: `dist/plugin.mjs` (matching tracked copy at `outputs/plugin.mjs`)
- Size: **580,376 bytes** (566.8 KiB; below 10 MiB)
- SHA-256: `8abec2ef62808c5eca612993b8709a7deb59e4675d1fb379d8201e4048734eaa`

## Readiness decision and next gate

**Hosted PayBox Marketplace BUY/SELL: NOT PROVEN.** The source contains a FAK order path that performs the documented Polymarket checks and submission contract, but no authenticated order or fill was attempted. The final public quote was stale, soccer providers returned 403, PayBox's native signing handoff and actual 10-second cold-start budget have not been exercised, and no authenticated CLOB BUY/SELL was attempted. Hosted compatibility and separate explicit live-trading approval remain required before claiming an end-to-end trade works.

No upload, hosted check, live signature, order broadcast, deposit, deployment, merge, or project submission was performed. Stop here for approval before final acceptance.
