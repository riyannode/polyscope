# PolyScope — implementation and compatibility readiness

Checked: 2026-10-16 19:18 UTC (2026-10-17 02:18 Asia/Jakarta)

Runtime: official PayBox starter 1.0.2, Node.js 24.21.0, pnpm 11.11.0

Decision: **LOCAL_CHECKS_PASSED; HOSTED_TRADING_COMPATIBILITY_NOT_PROVEN**

This report records local implementation and public-network checks. No PayBox hosted test, wallet-signing request, order broadcast, deposit, deployment, merge, or submission was performed.

## Implemented scope

The plugin keeps the approved four stages: public live data and news → PayBox agent research → explicit user decision → PayBox authorization and Polymarket order submission. There is no scheduler, deterministic strategy engine, Combo, Parlay, RFQ, or multi-leg order flow.

| Tool | Behavior |
|---|---|
| `search_markets` | Searches active Gamma markets and maps each outcome to its CLOB asset/position ID. |
| `get_quote` | Reads a fresh CLOB book, bounded depth, fillability, market fee descriptor, and fee estimate. |
| `get_soccer_news` | Reads ESPN RSS and returns only stories whose text names a requested team, with source/publication/observation times; content is marked untrusted. |
| `research_soccer` | Reads football-data.org PL, PD, SA, and CL fixtures/results. Exact fixture requests include last five completed results only when all five for both teams are present. xG, injuries, and lineups are `UNAVAILABLE`. |
| `prepare_clob_auth` | Prepares the official Polygon ClobAuth EIP-712 payload for an existing signer. |
| `validate_clob_auth_signature` | Recovers and checks the ClobAuth signer against the supplied signer address. |
| `prepare_order_signing` | Prepares one selected-outcome FAK BUY or SELL and separate typed-data intents for the order and explicit execution approval. BUY `priceLimit` is the user’s maximum; SELL `priceLimit` is the minimum. The approval binds price, size, fee parameters, nominal cap, wallet signature type, and `FAK`. |
| `validate_order_signature` | Rebuilds the approved order, checks the fee-inclusive cap, recovers the signer, constructs the Deposit Wallet ERC-7739 wrapper, and calls Polygon RPC for ERC-1271 validation on smart wallets. |
| `submit_fak_order` | Revalidates approval/signatures, market/book/fee, geo and account state, balance and exchange allowance, then sends exactly one FAK POST. A successful HTTP response returns `SUBMITTED`; it does not claim a fill. Ambiguous responses get one read-only order-hash reconciliation and then remain `UNKNOWN`; no automatic resubmit occurs. |
| `get_order_status` | Reads authenticated order/fill state. A positive matched amount takes precedence over a cancelled FAK remainder and is reported as `PARTIALLY_FILLED` or `FILLED`. |
| `cancel_order` | Sends an explicit cancellation request and reads order state if the result is ambiguous. |
| `get_portfolio` | Reads public single-market positions/PnL and labels the caller-supplied address `PUBLIC_ADDRESS_UNVERIFIED`; this is not proof of wallet ownership. |

Polymarket documents FAK as a supported market order, with a maximum BUY price or minimum SELL price; fee-inclusive BUY budgets must account for fees charged on top of notional. PolyScope binds the chosen `FAK` type and bounds into the separately signed execution approval and preserves it in the CLOB request. [Place Orders](https://docs.polymarket.com/trading/place-orders) · [Fees](https://docs.polymarket.com/trading/fees)

## Provider results and coverage

| Provider | Local result | What this proves |
|---|---|---|
| Polymarket Gamma | `AVAILABLE` | Current sample market search returned valid active market/outcome data. |
| Polymarket CLOB | `AVAILABLE`, `FRESH` | Final conformance quote had a book age of 4,020 ms. |
| ESPN RSS | `AVAILABLE` | Team-filtered soccer headlines and source timestamps were returned. This is not a verified injury or lineup feed. |
| football-data.org | `UNAVAILABLE` for PL, PD, SA, and CL; each request returned HTTP 403 | No real fixture, result, or form coverage is claimed. Local PayBox brokered secrets are absent. |

football-data.org currently lists the Premier League, LaLiga, Serie A, and Champions League under its Free Tier. Its API examples require `X-Auth-Token`. This supports choosing the provider, but does not prove the configured developer token works or that live coverage is available in a PayBox hosted call. [Coverage](https://www.football-data.org/coverage) · [API authentication examples](https://docs.football-data.org/general/v4/coding_client.html)

The deterministic offline suite uses isolated fixtures to validate mapping for all four competition codes and exact complete/incomplete form handling. Those fixtures are test data, not provider-coverage evidence. TheSportsDB is removed from the current path; its known disabled free API was not debugged again.

The generic market search and order tools use a single selected Polymarket CLOB market/outcome. Crypto, weather, soccer, politics, and finance are discoverable through the same market-data path when a corresponding active CLOB market exists. There are no specialized weather/xG/injury datasets or combo/multi-leg tools.

## PayBox signing and stateless runtime compatibility

The tools return `requestWalletSignIntent: { op: "typedData", typedData }` for ClobAuth, the Polymarket order, and PolyScope’s separate user execution approval. The connected PayBox agent must select its existing wallet credential, submit each applicable signing request through its native `request_wallet_sign`, poll `get_request`, and pass the returned signature to the matching plugin tool. The signed EOA is recovered against the supplied address; wallet-type, maker, signer, chain, and signature-type relationships are checked. Deposit Wallet preparation uses the documented `TypedDataSign` envelope and ERC-7739 wrapper path.

**Blocker:** the supplied PayBox plugin guide does not define a plugin-callable `request_wallet_sign` contract or document the exact native tool input/output schema. The plugin cannot invoke another agent tool itself. The agent-to-plugin orchestration and actual PayBox credential binding therefore remain unverified until a hosted read-only/signing check is approved. Offline tests cover typed-data construction, invalid-signature rejection, and Deposit Wallet payload shape, but not a valid credential signature or live ERC-1271 acceptance.

For each submit/status/cancel operation, the plugin derives or creates Polymarket L2 credentials from the supplied ClobAuth signature, uses them only in that invocation for HMAC-authenticated requests, and never returns or logs the API key, secret, passphrase, or private key. No persistent storage or alternate wallet is used. The submit preflight runs independent account/balance work concurrently and returns after the FAK POST; order read-back is a separate tool operation. Code timeouts are bounded, but no hosted 10-second timing or secret-redaction test was run. Hosted runtime acceptance remains open.

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
- The geoblock preflight checks Polymarket’s request-location endpoint. It is not proof of the end user’s physical/account eligibility; CLOB remains the final enforcement point.
- A missing/invalid credential, wallet mismatch, unsupported wallet signature, missing fee descriptor, stale book, closed/changed market, insufficient balance/allowance, geoblock, or timeout blocks submission. No fallback wallet or silent amount/order-type change exists.

## Changed files

- `src/plugin.ts` — research providers, fee-aware quoting, FAK approval/signing and CLOB lifecycle tools, bounded network calls.
- `scripts/conformance.mjs` — separates network conformance from offline deterministic coverage and adds FAK, signature-rejection, Deposit Wallet payload, stale-book, provider, and soccer checks.
- `scripts/test.mjs` — runs isolated deterministic fixtures and repeat-build checks without public network dependencies.
- `tests/network-fixtures.mjs` — offline-only deterministic HTTP fixtures; no signing key or order executor.
- `docs/errors.md` — stable error codes, retry guidance, and user-facing explanations.
- `outputs/POLYSCOPE_COMPATIBILITY.md` — this report.
- `outputs/plugin.mjs` — distributable copy of the built artifact.

The official 1.0.2 starter layout and pinned package manifest/lockfile were preserved; no backend, database, CLI, persistent state service, or new runtime dependency was added in this implementation update.

## Local validation

Toolchain used: Node.js `24.21.0`, pnpm `11.11.0`.

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS — deterministic build, schema checks, 15 offline behavior cases, no live submission |
| `pnpm conformance` | PASS — public market/news/quote reads and unsigned FAK preparation. Football calls correctly reported `UNAVAILABLE`/HTTP 403. |
| `pnpm audit --prod` | PASS — no known production dependency vulnerabilities reported |
| `git diff --check` | PASS before final report/artifact sync |

Offline cases include BUY/SELL FAK, fee-inclusive cap and approval binding, official market fee descriptor math, invalid approval/order signature rejection, Deposit Wallet typed-data envelope, stale book rejection, wrong outcome rejection, team attribution, all four deterministic competition mappings, complete/incomplete form handling, provider failure handling, public portfolio address labeling, and tool registration without order submission.

**Not covered locally:** a valid PayBox signature, actual EOA/Proxy/Safe/Deposit Wallet account binding, successful ERC-1271 validation, authenticated L2 credential derivation, balance/allowance/geoblock live behavior, partial-fill read-back, cancellation, or ambiguous POST reconciliation. These require valid wallet-controlled signing and/or authenticated CLOB behavior; no substitute wallet or mock trade was used. They remain release gates, not passing test claims.

Public CLOB books changed between runs: stale books at 100,678 ms and 98,994 ms were correctly rejected/skipped; fresh books at 25,694 ms and 4,020 ms allowed unsigned preparation. The final run passed. The report records this variation because public conformance depends on book freshness.

## Artifact

- Path: `dist/plugin.mjs` (copy at `outputs/plugin.mjs`)
- Size: **576,972 bytes** (0.55 MiB; below 10 MiB)
- SHA-256: `a9e05b3f5f1819f9b95147661494c7258904d821884f0c9dc5da101d1de9617d`

## Readiness decision and next gate

**Hosted PayBox Marketplace BUY/SELL: NOT PROVEN.** The source now contains a FAK order path that performs the documented Polymarket checks and submission contract. Local build, offline behavior, public data reads, and unsigned order preparation pass. The live provider token was not configured locally, PayBox’s native signing handoff and 10-second hosted execution have not been exercised, and no authenticated CLOB BUY/SELL or fill was attempted. A hosted/signing compatibility check and separate explicit live-trading approval are still required before claiming an end-to-end trade works.

No upload, hosted check, live signature, order broadcast, deposit, deployment, merge, or project submission was performed. Stop here for approval before final acceptance.
