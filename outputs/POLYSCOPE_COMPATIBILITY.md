# PolyScope PR #7 compatibility and validation

## Repository state

- Repository: [riyannode/polyscope](https://github.com/riyannode/polyscope)
- Existing PR: [#7](https://github.com/riyannode/polyscope/pull/7), Draft and unmerged
- Branch: `fix/clob-auth-recovery`
- Base and PR head were checked before editing; no newer PR head was found.
- This patch has not been merged, deployed, uploaded, or installed.

## Public MCP contract

The current plugin exposes exactly these 11 tools, with no compatibility aliases:

1. `search_markets`
2. `get_market_quote`
3. `research_soccer`
4. `analyze_soccer_edge`
5. `prepare_clob_auth`
6. `prepare_order`
7. `submit_order`
8. `get_order_status`
9. `cancel_order`
10. `get_trading_approvals`
11. `get_positions`

The public catalog was reduced from the historical 16-tool catalog. `get_quote`, `prepare_order_signing`, `get_trading_readiness`, and `get_portfolio` were renamed. The public news, FAK-only submission, and redemption-preview tools were removed. ClobAuth and Order signature validation remain internal to their real preparation/submission workflows; no standalone validator tools remain. Existing hosts must rediscover tool schemas; old tool names are not aliased.

## Contract corrections and safety

- `prepare_order` requires an explicit FAK or FOK `orderType` and returns SDK-effective signed amounts. `submit_order` verifies the same prepared type and signed fields before one SDK POST.
- Existing local signature validation, signer binding, geoblock preflight, and FAK/FOK binding remain in place.
- Ambiguous submission and cancellation outcomes receive at most one read-only reconciliation. The plugin never retries a POST or DELETE automatically.
- `get_order_status` and `cancel_order` require both `signerAddress` and `accountWalletAddress`; callers no longer supply order size or type. Size and type are read from the matching provider record and remain null when the record does not establish them.
- `get_trading_approvals` returns the SDK's indexed aggregate state and missing ERC-20/ERC-1155 requirements. It does not claim wallet balance, gas, per-order sufficiency, fresh finality, or trading eligibility.
- `get_positions` retains the Data API v2 OPEN single-market pagination semantics.
- Current news and lineup research continues through host-native browser/search capabilities, not a PolyScope news feed.

## Validation evidence

Validated with Node.js 24.21.0 and pnpm 11.11.0:

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm test` | PASS, 150.7 seconds; includes typecheck, two deterministic builds, and offline fixture suite |
| `pnpm conformance` | PASS; 11 tools discovered; read-only search and quote passed; soccer APIs returned HTTP 403; authenticated preparation not run |
| `pnpm audit --prod` | PASS; no known vulnerabilities reported |
| `git diff --check` | PASS |

The built bundle is **1,259,935 bytes** (below the 10 MiB limit), SHA-256 `f91354be099ceed811857ff25d82f6504e638b3394158660393ab4b433abc25d`. `dist/plugin.mjs` and `outputs/plugin.mjs` are byte-identical. Fixture success does not establish hosted PayBox behavior or live provider execution.

## Hosted and live status

PayBox-hosted schema discovery and signing handoff, hosted credential binding, authenticated provider acceptance, actual FAK/FOK submission/fill/status/cancellation, and current account approval state remain **UNVERIFIED** by this local patch. No live ClobAuth signing, order submission, cancellation, funding, approval, transfer, or redemption was performed. No transaction or order receipt is claimed.
