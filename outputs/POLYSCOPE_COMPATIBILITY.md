# PolyScope — implementation and compatibility readiness

Checked: 2026-10-17 (Asia/Jakarta)

Runtime: official PayBox starter 1.0.2, Node.js 24.22.0, pnpm 11.11.0

Decision: **LOCAL_CHECKS_PASSED; HOSTED_DISCOVERY_AND_PREPARATION_PASSED; LIVE_TRADING_UNVERIFIED**

This report records local implementation and public-network checks plus the project owner's PayBox hosted acceptance results below. This documentation update performed no additional hosted test, wallet-signing request, order broadcast, deposit, deployment, merge, or project submission.

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
| `research_soccer` | Reads football-data.org PL, PD, SA, and CL fixtures/results. Team-form requests use numeric competition IDs PL `2021`, PD `2014`, SA `2019`, and CL `2001`. Exact fixture requests include last five completed results only when all five for both teams are present. xG, injuries, and lineups are `UNAVAILABLE`. |
| `prepare_clob_auth` | Prepares the official Polygon ClobAuth EIP-712 payload for an existing signer. |
| `validate_clob_auth_signature` | Recovers and checks the ClobAuth signer against the supplied signer address. |
| `prepare_order_signing` | Prepares one selected-outcome FAK BUY or SELL and returns one Polymarket Order typed-data intent. BUY `priceLimit` is the maximum; SELL `priceLimit` is the minimum. Signed maker/taker amounts encode the chosen price and exact share size. Book age is informational and has no 120-second cutoff. |
| `validate_order_signature` | Rebuilds the Polymarket order, checks exact amount precision and fee-inclusive cap, recovers the signer, constructs the Deposit Wallet ERC-7739 wrapper, and calls Polygon RPC for ERC-1271 validation on smart wallets. |
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
| Polymarket CLOB | `AVAILABLE`, `STALE` | This follow-up conformance run returned a 45,599 ms book age and still prepared the unsigned order. Quote freshness remains informational for execution. |
| ESPN RSS | `AVAILABLE` | Team-filtered soccer headlines and source timestamps were returned. This is not a verified injury or lineup feed. |
| football-data.org direct API diagnostic | Brentford `402` and Liverpool `64`: baseline HTTP 200; adding `dateTo=2026-10-16` returned HTTP 400 for each; numeric `competitions=2021` without `dateTo` returned HTTP 200. The production query (`competitions=2021&status=FINISHED&limit=100`) returned HTTP 200 with six finished PL matches for each team. | The developer-supplied token can read PL team history for these two teams. It does not prove all-team or all-competition coverage, and no response body or token was retained. |
| `pnpm conformance` soccer calls | `UNAVAILABLE` for PL, PD, SA, and CL; each call returned HTTP 403 because the local runner has no PayBox host-scoped secret injection. | The offline/runtime harness correctly reports missing local credentials. The direct token diagnostic above is separate and is not a hosted PayBox test. |

football-data.org lists the four supported competitions in its Free Tier and sets a 10-request/minute rate limit for registered free clients. The controlled diagnostic used eight sequential requests, within that limit. Its successful `limit=100` query returned six rows for both tested PL teams; the data spanned Aug 22–Oct 10 for Brentford and Aug 23–Oct 11 for Liverpool, all before the Oct 17 fixture. This verifies those two team histories with the supplied token at the time of the check, not every supported league/team. PolyScope requests numeric competition ID, `status=FINISHED`, and `limit=100`, then independently filters exact competition ID, finished status, and kickoff earlier than the selected fixture before using five results. The `dateTo` failure's provider-side explanation remains unknown; the response body was not retained. The API uses `X-Auth-Token`. [Coverage](https://www.football-data.org/coverage) · [Pricing and rate limits](https://www.football-data.org/pricing) · [API authentication examples](https://docs.football-data.org/general/v4/coding_client.html)

The official Team Match API reference does not list `competitions`, while the official v4 quickstart does. The controlled requests resolved this for the current provider path: `competitions=2021` alone returned 200 for both teams, including at `limit=100`; adding `dateTo=2026-10-16` to the baseline returned 400 for both. The final request omits `dateTo` and retains the numeric competition filter. The v4 quickstart and official lookup map PL/PD/SA/CL to `2021`/`2014`/`2019`/`2001`. Provider HTTP errors remain status-specific and do not include response bodies or tokens. [Team Match API reference](https://docs.football-data.org/general/v4/team.html) · [v4 quickstart filter reference](https://www.football-data.org/documentation/quickstart) · [Official competition lookup table](https://docs.football-data.org/general/v4/lookup_tables.html)

The deterministic offline suite uses isolated fixtures to validate mapping and numeric team-form filters without `dateTo` for all four competitions, client-side filtering of mixed competitions/statuses/kickoff times, complete/incomplete form handling, and safe 403/429 diagnostics. Those fixtures are test data, not provider-coverage evidence. TheSportsDB is removed from the current path; its known disabled free API was not debugged again.

The generic market search and order tools use a single selected Polymarket CLOB market/outcome. Crypto, weather, soccer, politics, and finance are discoverable through the same market-data path when a corresponding active CLOB market exists. There are no specialized weather/xG/injury datasets or combo/multi-leg tools.

## PayBox signing and stateless runtime compatibility

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
  - `polygon-rpc.com`
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

`docs/errors.md` classifies remaining trade-path rejection codes as official Polymarket protocol requirements or exact user-approved order constraints. No redundant/custom PolyScope policy gate remains. The visible-liquidity rejection in `prepare_order_signing` was removed; `get_quote` continues to report liquidity, while preparation preserves the user's signed price/size and FAK behavior.

The official [API authentication guide](https://docs.polymarket.com/getting-started/api#authentication) requires a current Unix-seconds timestamp in ClobAuth but specifies no 300-second acceptance window. The [wallets and authentication guide](https://docs.polymarket.com/trading/wallets-auth) likewise gives no age limit. The local 300-second rejection was removed; signer recovery remains, and CLOB credential derivation is authoritative for timestamp acceptance. The official [Order format](https://docs.polymarket.com/trading/place-orders) includes a signed Unix-millisecond timestamp without a five-second future tolerance; that local cutoff was removed while retaining positive safe-integer encoding. Offline fixtures confirm these undocumented local cutoffs no longer block the adapter.

### Signing workflow, request count, and latency

| Stage | Before | After |
|---|---|---|
| Signing | PayBox Order + ClobAuth signatures plus a custom PolyScope `ExecutionApproval` signature | PayBox handles human approval and the official Polymarket Order signature; ClobAuth remains only for CLOB L1/L2 authentication |
| Freshness | 120-second preparation cutoff and 30-second submission rejection | Book age remains visible; the signed BUY maximum / SELL minimum and FAK semantics bound execution |
| Preflight | Four concurrent market/book/fee/geoblock reads, ClobAuth derivation, then close-only plus balance refresh/read | Four concurrent market/book/fee/geoblock reads and ClobAuth derivation; CLOB handles balance, allowance, account and exchange acceptance |
| Total submit requests | 9 requests on derived credentials, or 10 if L1 credential creation is needed | 6 requests on derived credentials, or 7 if L1 credential creation is needed |
| Total prepare + submit | 12 requests, or 13 with L1 credential creation | 9 requests, or 10 with L1 credential creation |

The request counts exclude PayBox's external wallet-sign request and optional ERC-1271 RPC call; ambiguous submission adds one read-only CLOB reconciliation in either version. The reduction removes three authenticated account reads. Preparation still makes three parallel reads (Gamma market, CLOB book, CLOB fee metadata). Submission makes its four provider reads concurrently with L1 credential derivation. Public requests have a 2.5-second timeout; authenticated CLOB and RPC calls have a 1.5-second timeout. For an EOA the normal timeout envelope is about 4 seconds (2.5-second parallel preflight + 1.5-second POST), or 4.5 seconds if credential creation follows a derive miss. An ambiguous POST can add one 1.5-second reconciliation; smart-wallet signature validation can add one 1.5-second RPC call before preflight. These are timeout envelopes, not measured latency promises. There is no custom overall budget; the PayBox host/tool deadline governs.

The official `@polymarket/client` package is Node 24 compatible, but its documented order examples build and sign through a configured signer. The current adapter must return unsigned EIP-712 data for PayBox's separate signing window and preserve the user's exact share size. The official `maxSpend` model reduces the signed BUY amount, so using that resizer would alter the selected share size; PolyScope instead checks the current fee against the all-in cap and rejects an over-cap exact order. The adapter remains minimal and does not add the SDK dependency. [Official TS SDK](https://github.com/Polymarket/ts-sdk) · [SDK limit-order example](https://github.com/Polymarket/ts-sdk/blob/main/examples/scripts/src/create-limit-order.ts) · [Order placement and `maxSpend`](https://docs.polymarket.com/trading/place-orders)


## Changed files

- `src/plugin.ts` — removes the custom ExecutionApproval signature, visible-liquidity rejection, 300-second ClobAuth age cutoff, five-second future Order-timestamp cutoff, 30-second submission and 120-second preparation hard gates, seven-second total budget, close-only read, and balance/allowance refreshes; retains bounded request timeouts, official geoblock, market identity/status, exchange constraints, exact signed price/size, fee-inclusive cap, and one-POST semantics.
- `scripts/conformance.mjs` — verifies a valid externally signed FAK order without ExecutionApproval reaches one intercepted POST; no visible liquidity, Gamma `restricted=true`, 51-second book age, 301-second ClobAuth age, and a correctly signed future Order timestamp do not add local policy rejections; fee caps and amount precision remain bounded, geoblock blocks, missing credentials reject, and ambiguous POST is not repeated.
- `tests/network-fixtures.mjs` — offline CLOB, Gamma, geoblock, credentials, no-visible-liquidity, and POST fixtures; no real signing or live order is performed.
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
| `pnpm test` | PASS — repeat builds were byte-identical and all offline cases passed, including one signed FAK fixture POST without ExecutionApproval, no-visible-liquidity preparation, 301-second ClobAuth age, future Order timestamp, exact price/size, fee cap, stale age, `restricted=true`, geoblock, missing credentials, and ambiguous POST non-retry; no live order submission |
| `pnpm conformance` | PASS — market/news/quote reads and preparation succeeded; quote age was 45,599 ms (`STALE`). PL, PD, SA, and CL returned HTTP 403 without local PayBox secret injection and were reported `UNAVAILABLE`. Tool catalog remained 12 tools. |
| `pnpm build` | PASS — Node.js 24.22.0 and pnpm 11.11.0; generated `dist/plugin.mjs` matches tracked `outputs/plugin.mjs` (575,597 bytes, SHA-256 `93fde516eeef3f4a8b946760cc01b215c88fba61eb963010abd29d909628d50f`). |
| `pnpm audit --prod` | PASS — no known production dependency vulnerabilities reported |
| `git diff --check` | PASS after source, report, and bundle updates |


Offline cases include exact BUY/SELL signed price and share amounts, one valid FAK order POST intercepted in a fixture without ExecutionApproval, no-visible-liquidity preparation, 301-second ClobAuth age, future signed Order timestamp, fee-inclusive caps (including changed fees), `restricted=true`, 51-second submission book age, 121-second preparation age, blocked geoblock, missing CLOB credentials, invalid order signature, one-time ambiguous POST reconciliation, Deposit Wallet typed-data envelope, team attribution, all four deterministic competition mappings and numeric team-form filters, complete/incomplete form handling, safe HTTP 403/429 diagnostics, provider failure handling, portfolio pagination, and 12-tool registration. Local signatures use generated test-only keys; fixture credentials and POSTs are not live CLOB evidence.

**Not covered locally:** PayBox signing-window `primaryType` behavior and wallet binding, real ERC-1271 acceptance, authenticated L2 credentials, live balance/allowance/geoblock behavior, real fills, status read-back, cancellation, or real ambiguous-POST reconciliation. The fixture demonstrates adapter behavior only; no live signature or trade was requested.

Current public conformance returned an AVAILABLE CLOB quote marked STALE at 45,599 ms and prepared the unsigned order. Soccer calls returned HTTP 403 without local PayBox secret injection. The separate historical direct API diagnostic remains unchanged and does not substitute for a hosted PayBox retest.

## Artifact

- Path: `dist/plugin.mjs` (matching tracked copy at `outputs/plugin.mjs`)
- Size: **575,597 bytes** (562.1 KiB; below 10 MiB)
- SHA-256: `93fde516eeef3f4a8b946760cc01b215c88fba61eb963010abd29d909628d50f`

## Readiness decision and next gate

**Hosted PayBox Marketplace BUY/SELL: NOT PROVEN.** The source contains a FAK order path that performs the documented Polymarket checks and submission contract, but no authenticated order or fill was attempted. The latest local quote was marked stale, but preparation succeeded and live trading remains unverified. Soccer calls returned 403 without local PayBox secret injection. PayBox's signing-window `primaryType` blocker, real wallet signing, and authenticated CLOB BUY/SELL have not been exercised. Hosted compatibility and separate explicit live-trading approval remain required before claiming an end-to-end trade works.

The tracked bundle was rebuilt in this PR and was not uploaded to hosted PayBox. No live signature, order broadcast, deposit, deployment, merge, or project resubmission was performed. The `Submitted` status above is the project owner's reported hackathon status, not an action taken in this update.
