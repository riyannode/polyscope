# PolyScope — PayBox public research and compatibility spike

Checked: 2026-10-17
Runtime: official PayBox plugin starter 1.0.2, Node.js 24.x, pnpm 11.11.0
Scope: public research, quote reads, and unsigned payload preparation. No order submission, cancellation, deposit, or live trading was attempted.

## Decision

The hosted plugin can discover active Polymarket markets, read public order books, return ESPN soccer headlines, query the four supported soccer competitions, and prepare an unsigned BUY/SELL EIP-712 payload for a selected outcome. Local conformance passed.

TheSportsDB returned HTTP 403 for all four league research calls during this run. Fixture, results, and form coverage are therefore **UNAVAILABLE** in the current provider state, so P0-A soccer research is incomplete. Gamma/CLOB and ESPN were reachable. Quote freshness uses a 30-second threshold; the same cached book was `FRESH` at 26,031 ms, then `STALE` at 41,205 ms and 114,900 ms in later runs.

This does not establish that PayBox Marketplace can execute a live BUY or SELL. The separate PayBox wallet-signing handoff, CLOB L2 credential derivation, account binding, Deposit Wallet ERC-7739 acceptance, and authenticated order submission remain unproven and unimplemented.

## Tools

| Tool | Behavior | Boundary |
|---|---|---|
| `search_markets` | Searches active Gamma events and maps every listed outcome to its public CLOB asset ID. Returns resolution text/source, market state, volume, liquidity, and observation time. | Public discovery only. Outcome names are preserved; non-binary markets are supported. |
| `get_quote` | Reads the selected outcome's CLOB book, returns best bid/ask and bounded depth, and optionally estimates visible fillable shares, worst/average price, and gross pUSD. | BUY uses asks; SELL uses bids. Quote freshness is marked `FRESH`, `STALE` after 30 seconds, or `UNKNOWN`. Fees and account-specific geoblock are not checked. |
| `research_soccer` | Reads TheSportsDB schedules/results for PL, PD, SA, or CL. Exact fixture IDs are matched literally. Returned past results are explicitly partial samples. | Provider limits apply. This run returned HTTP 403 for each league, so no fixture/form data was available. |
| `get_soccer_news` | Reads ESPN's public soccer RSS feed, preserving the supplied headline, summary, article URL, and publication time. | Items are labeled `REPORTED` and untrusted; they are not verified injury or lineup records. Items older than 24 hours are `STALE`. |
| `prepare_clob_auth` | Builds the Polygon ClobAuth EIP-712 payload and PayBox `typedData` intent. | Does not request a signature or derive CLOB credentials. |
| `prepare_order_signing` | Validates the selected market/outcome, CLOB book, wallet type, tick size, minimum size, decimal amounts, and caller-supplied amount cap, then returns the selected outcome and unsigned EIP-712 payload. | No order is submitted. BUY cap is pre-fee pUSD; SELL cap is shares. |
| `validate_clob_auth_signature` | Recovers the signer from the ClobAuth payload and compares it with the expected address. | No signature was obtained in this run. |
| `validate_order_signature` | Recovers the order signer and can construct the documented Deposit Wallet ERC-7739 wrapper. | No signature was obtained; on-chain ERC-1271 acceptance is not tested. |

The connected PayBox agent must separately select an existing wallet credential, compare its public address with the intended signer, call `request_wallet_sign`, and poll `get_request`. The plugin does not call that native tool itself. The local payload check used a synthetic EOA address only as unsigned builder input; it requested no signature and sent no order.

## Provider results from this run

| Provider | Result | Evidence and limitation |
|---|---|---|
| Polymarket Gamma | AVAILABLE | The `search_markets` sample call returned schema-valid active market/outcome data. |
| Polymarket CLOB | AVAILABLE | `get_quote` returned an order book. The final tested quote was marked `STALE` because its timestamp was 114,900 ms old, above the 30-second threshold. |
| ESPN RSS | AVAILABLE | `get_soccer_news` returned schema-valid current feed items with source links and timestamps. Hosted PayBox access remains untested. |
| TheSportsDB v1 | UNAVAILABLE | `research_soccer` returned HTTP 403 for PL, PD, SA, and CL. No fixture or form result is claimed. |

No BBC, weather, football-data.org, Sportmonks, xG, injury registry, or user-provided API key integration was added. No provider fallback was used after TheSportsDB's 403.

## PayBox signing and stateless runtime

The plugin can emit the typed-data intent expected by PayBox's documented `request_wallet_sign` flow, but an actual credential-bound signature was not available. Address binding, approval presentation, and signature recovery from PayBox remain unverified against a hosted agent session.

Polymarket L2 credentials are created or derived after a ClobAuth signature and used for HMAC-authenticated private CLOB requests. No `/auth/api-key`, `/auth/derive-api-key`, or authenticated order endpoint was called. Since the PayBox sandbox is stateless across invocations, a later submit call could not rely on credentials retained by an earlier invocation. In-memory credential handling within a single hosted invocation, its 10-second runtime limit, and secret non-exposure in hosted logs have not been proven.

The local Deposit Wallet payload follows the documented `TypedDataSign`/ERC-7739 shape, but the wallet's ERC-1271 verifier has not accepted it. No order POST was sent, so order status, fills, cancellation, retry, and ambiguous-POST recovery have not been exercised. A future timeout must be treated as `UNKNOWN` and reconciled before any retry.

## Changed files and dependencies

Changed starter files: `src/plugin.ts`, `scripts/conformance.mjs`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and `paybox-plugin.json`. The generated distributable is `outputs/plugin.mjs`. The 1.0.2 starter layout, `src/paybox.ts`, Node 24 target, and pnpm 11.11.0 pin are preserved. No backend, database, CLI, helper service, persistent process, or user API secret was added.

`fast-xml-parser@5.11.2` is the only new direct dependency and is used for bounded RSS XML parsing; XML entity expansion is disabled and DOCTYPE input is rejected. `pnpm-workspace.yaml` overrides transitive `ws` to `8.21.0` after the starter's `8.20.1` version appeared in a high-severity audit finding.

## Validation

- `pnpm install --frozen-lockfile` — passed with Node.js 24.20.0 and pnpm 11.11.0.
- `pnpm typecheck` — passed as part of `pnpm test`.
- `pnpm test` — passed: strict typecheck, two deterministic builds, MCP conformance, public market search, ESPN news, all four league calls, quote read, and unsigned order-payload preparation.
- `pnpm audit --prod` — passed after the `ws@8.21.0` override; no known production dependency vulnerabilities reported.
- TheSportsDB calls returned a valid `UNAVAILABLE` result with HTTP 403; the tool operation itself passed schema conformance. This is provider access evidence, not fixture coverage.
- Final local artifact: 552,708 bytes; SHA-256 `14d3991790376b2c3312a4772367df9d71a08b83f52edc85b5810ed94ccc2d5a`.
- No PayBox portal upload or hosted check was run. Local conformance does not establish hosted network access or marketplace approval.

## Portal network configuration

Allow only these HTTPS hostnames for the current bundle:

- `gamma-api.polymarket.com`
- `clob.polymarket.com`
- `www.thesportsdb.com`
- `www.espn.com`

No environment variables, user API keys, or builder secrets are required for these public reads or unsigned payload preparation. Redirects are rejected; do not add another hostname unless a hosted check establishes it is required and the change is approved.

## Remaining gates

1. Restore/verify TheSportsDB access and independently establish actual coverage for PL, PD, SA, and CL; until then, soccer fixture/form research remains unavailable.
2. Run PayBox hosted upload/tests and verify its exact public-host allowlist behavior.
3. Prove the real PayBox `request_wallet_sign` credential/address binding, approval flow, EIP-712 signature recovery, and Deposit Wallet verifier acceptance.
4. Prove ClobAuth L2 credential derivation inside the stateless 10-second runtime without output or log exposure.
5. Separately authorize and implement private CLOB submission, balance/allowance and geoblock checks, fee-inclusive caps, order-status reconciliation, cancellation, portfolio, and PnL. None are implemented here.

No trading, signing, order POST, deposit, or persistent process was started. No cleanup was required.

## Source references

- [PayBox plugin requirements and starter](https://developer.paybox.sh/requirements.md)
- [PayBox wallet signing and plugin orchestration](https://docs.paybox.sh/reference/mcp-tools#request_wallet_sign)
- [Polymarket wallets and CLOB authentication](https://docs.polymarket.com/trading/wallets-auth)
- [Polymarket order signing and submission](https://docs.polymarket.com/trading/place-orders)
- [Polymarket market details](https://docs.polymarket.com/market-data/market-details)
- [TheSportsDB API documentation](https://www.thesportsdb.com/documentation)
- [ESPN RSS information and usage](https://www.espn.in/espn/news/story?page=rssinfo)
