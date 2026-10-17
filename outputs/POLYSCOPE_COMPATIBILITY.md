# PolyScope — implementation and compatibility readiness

Checked: 2026-10-17 (Asia/Jakarta)

Runtime: official PayBox starter 1.0.2, Node.js 24.22.0, pnpm 11.11.0

Documentation-review build verification used Node.js 24.20.0 and pnpm 11.11.0 in a temporary copy so the existing uploaded bundle was not overwritten.

Decision: **LOCAL_CHECKS_PASSED; SOCCER_SKILL_HOST_LOADING_UNVERIFIED; PR3_INTEGRATION_PENDING; LIVE_TRADING_UNVERIFIED**

This report includes historical local implementation and public-network checks plus the project owner's PayBox hosted acceptance results below. PR #4 adds API-first, browser-extended research on a base that does not yet contain PR #3. This follow-up patch performs no live agent/browser research, hosted test, wallet-signing request, order broadcast, deposit, deployment, merge, or project submission.

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
| Developer Dashboard `prepare_order_signing` | `PASS` | Order and approval payload preparation only; no wallet signature was verified. |

**Still `UNVERIFIED`:** PayBox wallet credential selection and `request_wallet_sign` approval/read-back, wallet binding from a real signature, authenticated Polymarket CLOB L1/L2 access, real BUY/SELL submission, and order/fill read-back. Passing payload-preparation tools does not prove signing or trading compatibility.

## Implemented scope

The plugin keeps the approved four stages: public live data and news → PayBox agent research → explicit user decision → PayBox authorization and Polymarket order submission. There is no scheduler, deterministic strategy engine, Combo, Parlay, RFQ, or multi-leg order flow.

| Tool | Behavior |
|---|---|
| `search_markets` | Searches active Gamma markets and maps each outcome to its CLOB asset/position ID. |
| `get_quote` | Reads a fresh CLOB book, bounded depth, fillability, market fee descriptor, and fee estimate. |
| `get_soccer_news` | Reads team-attributed ESPN RSS evidence. Its MCP description directs agents to continue with host-native browser/search tools for missing relevant information. |
| `research_soccer` | Reads football-data.org PL, PD, SA, and CL fixtures/results and available recent form. Returns available partial results and counts; the MCP description directs agents to continue with host-native browser/search tools for missing information. The repository skill covers xG/xGA, injuries, suspensions, confirmed and predicted lineups, standings, team news, and other match context. |
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
| football-data.org direct API diagnostic | Brentford `402` and Liverpool `64`: baseline HTTP 200; adding `dateTo=2026-10-16` returned HTTP 400 for each; numeric `competitions=2021` without `dateTo` returned HTTP 200. The production query (`competitions=2021&status=FINISHED&limit=100`) returned HTTP 200 with six finished PL matches for each team. | The developer-supplied token can read PL team history for these two teams. It does not prove all-team or all-competition coverage, and no response body or token was retained. |
| `pnpm conformance` soccer calls | `UNAVAILABLE` for PL, PD, SA, and CL; each call returned HTTP 403 because the local runner has no PayBox host-scoped secret injection. | The offline/runtime harness correctly reports missing local credentials. The direct token diagnostic above is separate and is not a hosted PayBox test. |

football-data.org lists the four supported competitions in its Free Tier and sets a 10-request/minute rate limit for registered free clients. The controlled diagnostic used eight sequential requests, within that limit. Its successful `limit=100` query returned six rows for both tested PL teams; the data spanned Aug 22–Oct 10 for Brentford and Aug 23–Oct 11 for Liverpool, all before the Oct 17 fixture. This verifies those two team histories with the supplied token at the time of the check, not every supported league/team. PolyScope requests numeric competition ID, `status=FINISHED`, and `limit=100`, then independently filters exact competition ID, finished status, and kickoff earlier than the selected fixture before using five results. The `dateTo` failure's provider-side explanation remains unknown; the response body was not retained. The API uses `X-Auth-Token`. [Coverage](https://www.football-data.org/coverage) · [Pricing and rate limits](https://www.football-data.org/pricing) · [API authentication examples](https://docs.football-data.org/general/v4/coding_client.html)

### PR #4 soccer research continuation

`skills/polyscope-soccer-research/SKILL.md` instructs the host agent to use API form even when partial, then continue with available host-native browser/search tools for missing xG/xGA, injuries, suspensions, lineups, standings, team news, and other relevant context. The agent must cite original URLs and publication/observation times and report uncertainty. If the host cannot browse, it must say so; skill text and offline checks do not prove a live agent browsed.

Both built MCP tool definitions, `research_soccer` and `get_soccer_news`, include browser-continuation instructions. Automated offline checks verify these descriptions and the skill guidance for missing xG, missing injury information, and unavailable browser tools. Those checks establish presence of instructions only; they do not establish PayBox skill installation, automatic `SKILL.md` loading, or live browser use. PayBox `SKILL.md` loading is **UNVERIFIED**. The [official PayBox plugin README](https://github.com/moonpay/paybox-plugin/blob/main/README.md) describes MCP tools and packaged skills but does not specify automatic loading of arbitrary repository skills.

Recent-form output preserves actual results and per-team counts. `COMPLETE_LAST_5` means five results for each team, `PARTIAL` means at least one result exists but combined coverage is incomplete, and `UNAVAILABLE` means neither team has usable results. The aggregate reason identifies incomplete teams and includes their counts and source-specific provider errors.

### PR #3 integration status

PR #3, [Simplify PayBox Polymarket FAK signing flow](https://github.com/riyannode/polyscope/pull/3), remains open and unmerged. PR #4 remains based on current `main`; do not treat this branch as the final combined trading implementation. Its base still has the `ExecutionApproval` fields, `marketRestricted` and `accountGeoblockChecked` schema fields, 30-second execution and 120-second preparation freshness checks, the 7-second execution budget, and the redundant account/balance/allowance preflight. PR #3 removes those items and updates the related assertions in `scripts/conformance.mjs`, fixture cases in `tests/network-fixtures.mjs`, and tracked `outputs/plugin.mjs`. The temporary merge reported content conflicts in `scripts/conformance.mjs` and `outputs/POLYSCOPE_COMPATIBILITY.md`; `src/plugin.ts`, `tests/network-fixtures.mjs`, and `README.md` merged automatically. The conflicts were resolved only in the temporary checkout, preserving PR #3's trading assertions and combining PR #4's soccer cases. A temporary PR #3 + PR #4 checkout passed install, typecheck, test, conformance, build, and production audit. Its regenerated `outputs/plugin.mjs` matched `dist/plugin.mjs` at 576,893 bytes (SHA-256 `8a1872fd420661f1460806e8ccda0269bfaea4af5b312e63c3f94385500235cb`). PR #4 itself is still based on `main`; after PR #3 lands, rebase/integrate and regenerate the tracked bundle from the merged source before merge/release. No PR history or `main` was changed for the temporary check.

The official Team Match API reference does not list `competitions`, while the official v4 quickstart does. The controlled requests resolved this for the current provider path: `competitions=2021` alone returned 200 for both teams, including at `limit=100`; adding `dateTo=2026-10-16` to the baseline returned 400 for both. The final request omits `dateTo` and retains the numeric competition filter. The v4 quickstart and official lookup map PL/PD/SA/CL to `2021`/`2014`/`2019`/`2001`. Provider HTTP errors remain status-specific and do not include response bodies or tokens. [Team Match API reference](https://docs.football-data.org/general/v4/team.html) · [v4 quickstart filter reference](https://www.football-data.org/documentation/quickstart) · [Official competition lookup table](https://docs.football-data.org/general/v4/lookup_tables.html)

The deterministic offline suite uses isolated fixtures to validate mapping and numeric team-form filters without `dateTo` for all four competitions, client-side filtering of mixed competitions/statuses/kickoff times, complete/incomplete form handling, and safe 403/429 diagnostics. Those fixtures are test data, not provider-coverage evidence. TheSportsDB is removed from the current path; its known disabled free API was not debugged again.

The generic market search and order tools use a single selected Polymarket CLOB market/outcome. Crypto, weather, soccer, politics, and finance are discoverable through the same market-data path when a corresponding active CLOB market exists. There are no specialized weather/xG/injury datasets or combo/multi-leg tools.

## PayBox signing and stateless runtime compatibility

The tools return `requestWalletSignIntent: { op: "typedData", typedData }` for ClobAuth, the Polymarket order, and PolyScope’s separate user execution approval. The connected PayBox agent must select its existing wallet credential, submit each applicable signing request through its native `request_wallet_sign`, poll `get_request`, and pass the returned signature to the matching plugin tool. The signed EOA is recovered against the supplied address; wallet-type, maker, signer, chain, and signature-type relationships are checked. Deposit Wallet preparation uses the documented `TypedDataSign` envelope and ERC-7739 wrapper path.

**Blocker:** the supplied PayBox plugin guide does not define a plugin-callable `request_wallet_sign` contract or document the exact native tool input/output schema. The plugin cannot invoke another agent tool itself. The reported hosted research calls and Dashboard payload-preparation checks do not validate the connected agent's signing handoff or PayBox wallet binding; wallet credential selection, `request_wallet_sign`, and `get_request` signature read-back remain `UNVERIFIED`. Offline tests cover typed-data construction, invalid-signature rejection, and Deposit Wallet payload shape, but not a valid credential signature or live ERC-1271 acceptance.

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

- `src/plugin.ts` — exact order-hash and signer approval binding, bounded FAK submit/reconciliation budget, egress-IP geoblock wording, v2 cursor-paginated OPEN positions, and team history query without the 400-producing date filter.
- `scripts/conformance.mjs` — baseline trading assertions plus browser-continuation catalog and form-result coverage regressions for 5/5, 5/4, 5/0, 0/0, and safe 403/429 cases.
- `tests/network-fixtures.mjs` — representative Data API v2 rows and pagination plus offline-only request timing, numeric competition filters, date-filter rejection, 5/4 and 0/0 form histories, and safe 403/429 fixtures; not live CLOB credentials or trade evidence.
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
| `pnpm test` | PASS — Node.js `24.22.0`, pnpm `11.11.0`; deterministic build and offline form cases for 5/5, 5/4, 5/0, 0/0, HTTP 403, and HTTP 429. Checks tool-description and skill text only for browser continuation; no live agent browsing or order submission. |
| `pnpm conformance` | PASS — `get_quote` returned an available but stale book at 53,071 ms; `prepare_order_signing` returned an unsigned prepared order and did not submit it. PL, PD, SA, and CL calls returned HTTP 403 without local PayBox secret injection and were reported `UNAVAILABLE` with a safe permission/plan reason. |
| `pnpm build` | PASS — generated `dist/plugin.mjs` from this branch's source. |
| `pnpm audit --prod` | PASS — no known production dependency vulnerabilities reported |
| `git diff --check` | PASS after source, docs, and fixture edits |
| Tracked `outputs/plugin.mjs` | NOT REGENERATED — it must be built from the final PR #3 + PR #4 integration state after PR #3 lands. |
| README links and logo review | PASS — all local README links resolve and all four external links returned HTTP 200. PNG corner alpha is 0 and sampled white emblem pixels remain opaque; a 48×48 preview was reviewed on white and dark backgrounds. White details blend into white backgrounds, while the overall mark remains recognizable. |

Offline cases include BUY/SELL FAK, fee-inclusive cap and exact order-hash/signing-address approval binding, rejection of approval replay with a different salt or signer, slow preflight stopping before FAK POST without enough time reserved for reconciliation, official market fee descriptor math, invalid approval/order signature rejection, Deposit Wallet typed-data envelope, stale-book rejection, wrong outcome rejection, team attribution, all four deterministic competition mappings and numeric team-form filters, 5/5 complete form, retained 5/4 and 5/0 partial form, 0/0 unavailable form, accurate team-specific 403/429 errors, provider failure handling, representative Data API v2 position rows and cursor pagination completeness, public portfolio address labeling, tool-catalog continuation wording, and skill workflow text checks. The latter do not show a live agent performed browser research. Local signatures use generated test-only keys; credential/account transport fixtures are not authenticated CLOB evidence or a successful trade.

**Not covered locally:** PayBox `request_wallet_sign` handoff and wallet binding, actual EOA/Proxy/Safe/Deposit Wallet account binding, successful ERC-1271 validation, authenticated L2 credential derivation, live balance/allowance/geoblock behavior, partial-fill read-back, cancellation, or ambiguous POST reconciliation. These require hosted PayBox behavior and/or authenticated CLOB responses; local transport fixtures do not establish them. They remain release gates, not passing test claims.

This branch's latest public conformance returned a CLOB book 53,071 ms old, labeled `STALE`; unsigned preparation still completed and no order was submitted. Soccer calls returned HTTP 403 without local PayBox secret injection. Separately, the controlled direct API calls verified PL history for Brentford and Liverpool as described above; this does not substitute for a PayBox hosted retest or establish PD/SA/CL form coverage.

## Artifact

`pnpm build` generated and conformance inspected this branch's `dist/plugin.mjs`, including both continuation descriptions. Tracked `outputs/plugin.mjs` is not updated on this pre-PR3 branch. In a temporary PR #3 + PR #4 checkout, the generated `dist/plugin.mjs` was copied to the temporary tracked output and matched byte-for-byte at 576,893 bytes (SHA-256 `8a1872fd420661f1460806e8ccda0269bfaea4af5b312e63c3f94385500235cb`). Regenerate the tracked artifact from the final rebased source after PR #3 merges.

## Readiness decision and next gate

**Hosted PayBox Marketplace BUY/SELL: NOT PROVEN.** No authenticated order or fill was attempted. The latest PR #4 branch conformance returned a stale public quote and soccer calls returned 403 without local PayBox secret injection. The separate combined PR #3 + PR #4 conformance returned a fresh quote and prepared an unsigned order. Neither run exercised PayBox's signing handoff or authenticated CLOB BUY/SELL.

No new bundle was uploaded and no live signature, order broadcast, deposit, deployment, merge, or project resubmission was performed by this documentation update. The `Submitted` status above is the project owner's reported hackathon status, not an action taken in this update.
