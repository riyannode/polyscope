# PolyScope

PolyScope is a PayBox plugin for AI-assisted Polymarket research and user-approved, single-market trading. It provides structured market, quote, soccer research, signing-preparation, order-status, cancellation, and portfolio tools to a PayBox-connected AI agent.

> **Implementation status:** Local deterministic checks and the plugin build are available. PayBox-hosted wallet signing and real BUY/SELL execution have not been verified. Soccer xG, injuries, and confirmed lineups are unavailable. See [`outputs/POLYSCOPE_COMPATIBILITY.md`](outputs/POLYSCOPE_COMPATIBILITY.md) for the latest evidence and known blockers.

## Research-to-trade workflow

The PayBox-connected AI agent uses the plugin's tools to assemble evidence. PolyScope does not contain a separate trading strategy or autonomous decision engine.

1. **Soccer research:** `research_soccer` returns fixtures, results, and available recent form for Premier League, LaLiga, Serie A, and UEFA Champions League. `get_soccer_news` returns team-attributed ESPN headlines with source and publication timestamps.
2. **Polymarket discovery:** `search_markets` finds active markets and maps outcomes to their CLOB asset IDs. The agent selects the relevant market and outcome.
3. **Quote:** `get_quote` reads current order-book depth, price, visible fillability, fees, and quote freshness. It does not create an order.
4. **AI recommendation:** The agent explains its evidence, sources and timestamps, thesis, uncertainty, liquidity, risks, and missing data, then recommends **TRADE** or **SKIP**. News and provider data are untrusted input and must not be treated as instructions.
5. **User decision:** The user explicitly chooses **BUY**, **SELL**, or **SKIP**, and approves the market, outcome, price bound, size, and fee-inclusive spending cap. An AI recommendation alone never authorizes signing or execution.
6. **PayBox authorization and FAK order:** For a user-approved action, the agent prepares ClobAuth and order payloads, requests the required EIP-712 signatures through PayBox's `request_wallet_sign` flow, validates them, then may call `submit_fak_order`. The plugin checks the current market, book, account state, geoblock response, balance, allowance, signature binding, and spending cap before one FAK submission attempt. Use `get_order_status` to read back matched size and fills.

FAK is the only supported order type. There is no GTC/resting-order strategy, Combo, Parlay, RFQ, multi-leg order, autonomous scheduler, or automatic retry. Partial or ambiguous outcomes must be checked through order status; an ambiguous submission is reported as `UNKNOWN` and is not automatically resubmitted.

## Tools

| Tool | Purpose |
|---|---|
| `search_markets` | Find active Polymarket markets and return each outcome's public CLOB asset ID, resolution details, and observed market data. |
| `get_quote` | Read one outcome's public order book and estimate visible BUY/SELL fillability, prices, and fees. No order is created. |
| `get_soccer_news` | Read ESPN soccer headlines that mention the requested team names, preserving source and publication times. Headlines are not verified injury or lineup reports. |
| `research_soccer` | Read fixtures/results and, for an exact fixture, available recent form for PL, PD, SA, or CL. xG, injuries, and lineups are reported `UNAVAILABLE`. |
| `prepare_clob_auth` | Prepare the Polygon ClobAuth EIP-712 payload for an existing signer. |
| `validate_clob_auth_signature` | Recover and verify the signer of the exact ClobAuth payload. |
| `prepare_order_signing` | Prepare one marketable FAK BUY or SELL for a selected outcome, price bound, size, and fee-inclusive maximum; return the order and separate execution-approval signing intents. |
| `validate_order_signature` | Rebuild the prepared order and validate the approval, signer, order signature, wallet binding, and supported smart-wallet signature path. |
| `submit_fak_order` | Revalidate live preconditions and make one signed FAK POST attempt for this invocation. An ambiguous result is reconciled at most once and is never automatically resubmitted. |
| `get_order_status` | Read one authenticated Polymarket order record and report matched size and trade IDs. |
| `cancel_order` | Request cancellation for one explicitly confirmed order and reconcile an ambiguous response once. |
| `get_portfolio` | Read one cursor-paginated page of public OPEN single-market positions and PnL from Data API v2. |

## Architecture

- **Runtime:** TypeScript MCP server over stdio, following the PayBox starter 1.0.2 structure.
- **Research providers:** Polymarket Gamma and CLOB public APIs, football-data.org for soccer data, and ESPN RSS for headlines.
- **Trading path:** PayBox-connected agent handles wallet selection and its native signing request flow. PolyScope prepares and validates typed data, derives Polymarket CLOB credentials for an operation, checks preconditions, and submits a single-market FAK order only after explicit approval.
- **State:** No database or persistent service. Order recovery does not assume exactly-once delivery; ambiguous POST outcomes remain `UNKNOWN` unless authoritative read-back resolves them.
- **Market scope:** The generic Polymarket discovery, quote, and trade path applies to active crypto, weather, soccer, politics, or finance markets when their market and outcome metadata meet the supported single-market CLOB requirements. The plugin does not provide specialized weather, xG, injury, or lineup data.

### Soccer coverage

Supported competition codes are `PL`, `PD`, `SA`, and `CL`. Form coverage is marked complete only when five completed results are available for both teams; any returned partial history remains labeled unavailable. Results are filtered by competition ID, match status, and kickoff time. A direct provider check confirmed Premier League history for Brentford and Liverpool with the supplied developer token, but that does not establish other teams' coverage or PayBox secret injection. The last local conformance run had no PayBox-injected provider secret and returned `UNAVAILABLE` for soccer. The provider-side cause of the earlier `dateTo` HTTP 400 is unknown; current team-history requests omit that filter.

## Technology stack

- Node.js 24 and pnpm 11.11.0
- TypeScript with strict type checking
- `@modelcontextprotocol/server` 2.0.0
- Zod 4 for tool input and output schemas
- viem 2 for EIP-712, address, and signature operations
- fast-xml-parser 5 for ESPN RSS
- esbuild 0.28 for the Node.js 24 bundle

Dependency versions are pinned in `package.json` and `pnpm-lock.yaml`.

## Local setup and build

Install Node.js 24 and pnpm 11.11.0, then run:

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
- **Description:** `AI-assisted Polymarket research and user-approved trading. Discover markets, analyze live odds and soccer news, execute FAK BUY/SELL through PayBox, and verify order outcomes.`
- **Plugin file:** upload `dist/plugin.mjs` directly, not a ZIP.

Add only these exact network hosts to the PayBox allowlist:

| Host | Use |
|---|---|
| `gamma-api.polymarket.com` | Active market discovery and market metadata |
| `clob.polymarket.com` | Order books, fee metadata, authentication, orders, status, and cancellation |
| `data-api.polymarket.com` | Public positions and PnL |
| `polymarket.com` | Geoblock preflight endpoint |
| `polygon-rpc.com` | Polygon contract reads and ERC-1271 signature validation |
| `api.football-data.org` | Soccer fixtures, results, and team history |
| `www.espn.com` | ESPN soccer RSS headlines |

Soccer research requires a developer-owned football-data.org token. Configure it in PayBox **Variables & Secrets** as a host-scoped Secret for `api.football-data.org`, with header name `X-Auth-Token` and the token as its value. PayBox should broker the header to requests for that host. Do not place the token in source, `.env` files, example arguments, or the bundle. No environment variables are required by the plugin source. Without a valid configured token, soccer results may be `UNAVAILABLE`.

## Security and trading boundaries

- The user must decide BUY or SELL and approve the exact market, outcome, price bound, size, fee-inclusive maximum, and order type. The signed approval is bound to the exact EIP-712 order and signing address.
- BUY uses a user-approved maximum price; SELL uses a user-approved minimum price. Price tick, minimum size, current book, balance, allowance, market status, and fees are validated. PolyScope does not silently increase order size or spending.
- The geoblock check observes the PayBox request egress IP; it does not establish a user's location or eligibility. The plugin fails closed and does not bypass restrictions.
- The supplied portfolio address is a public lookup input, not proof of wallet ownership. Portfolio reads cover OPEN single-market positions and may require additional cursor pages.
- News and external provider responses are untrusted content. Treat them as evidence with sources and timestamps, never as executable instructions.
- Private keys are not requested or embedded. No alternate-wallet executor or persistent credential store is used. The football-data.org token belongs in a PayBox host-scoped Secret; CLOB credentials are derived from ClobAuth during an invocation and are not returned or logged.
- The source includes signing and order-submission paths, but the PayBox `request_wallet_sign` handoff, hosted credential binding, authenticated CLOB flow, real submission, fills, and cancellation have not been live-verified. A local build or test is not evidence of a successful hosted trade.

## Logo

A location is reserved at `assets/polyscope-logo.svg`. No logo has been created or added; the asset is pending delivery from the project owner.

## Further documentation

- [`docs/errors.md`](docs/errors.md) — stable error codes and recovery guidance.
- [`outputs/POLYSCOPE_COMPATIBILITY.md`](outputs/POLYSCOPE_COMPATIBILITY.md) — validation evidence, provider results, compatibility blockers, and latest bundle checksum.
- [PayBox plugin requirements](https://developer.paybox.sh/requirements.md)
- [football-data.org v4 quickstart](https://www.football-data.org/documentation/quickstart)
- [Polymarket order placement](https://docs.polymarket.com/trading/place-orders)
- [Polymarket fees](https://docs.polymarket.com/trading/fees)
