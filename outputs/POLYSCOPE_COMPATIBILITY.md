# PolyScope compatibility and validation

## Repository state

- Repository: [riyannode/polyscope](https://github.com/riyannode/polyscope)
- Documentation cleanup starts from current `main`, commit `62739172ad9facfb4753b0f04ac279e1440e35a1`.
- PR [#7](https://github.com/riyannode/polyscope/pull/7) and PR [#9](https://github.com/riyannode/polyscope/pull/9) are merged into `main`.
- This submission-readiness change updates documentation only; plugin behavior is unchanged.

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
- Existing local signature validation, signer binding, and FAK/FOK binding remain in place.
- Ambiguous submission and cancellation outcomes receive at most one read-only reconciliation. The plugin never retries a POST or DELETE automatically.
- `get_order_status` and `cancel_order` require both `signerAddress` and `accountWalletAddress`; callers no longer supply order size or type. Size and type are read from the matching provider record and remain null when the record does not establish them.
- `get_trading_approvals` returns the SDK's indexed aggregate state and missing ERC-20/ERC-1155 requirements. It does not claim wallet balance, gas, per-order sufficiency, fresh finality, or trading eligibility.
- `get_positions` retains the Data API v2 OPEN single-market pagination semantics.
- Current news and lineup research continues through host-native browser/search capabilities, not a PolyScope news feed.

## Local validation evidence (2026-10-18)

Validated with Node.js 24.21.0 and pnpm 11.11.0:

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS, 149.4 seconds; includes typecheck, two deterministic builds, and offline fixture suite |
| `pnpm conformance` | PASS; 11 tools discovered; live search and fresh quote passed; local soccer calls returned `UNAVAILABLE` / HTTP 403; authenticated preparation not run |
| `pnpm build` | PASS |
| `pnpm audit --prod` | PASS; no known vulnerabilities reported |
| `git diff --check` | PASS |

The built bundle is **1,259,531 bytes** (below the 10 MiB limit), SHA-256 `b9753481c5a1e391d755e466f29713f97c3f405ecc5d93831178bca460d15e07`. `dist/plugin.mjs` and `outputs/plugin.mjs` are byte-identical. Fixture success does not establish hosted PayBox behavior or live provider execution. The local soccer calls had no configured provider credentials; they do not reproduce the supplied hosted research validation. Gitleaks 8.30.1 scanned all 14 existing commits and found no leaks.

## Hosted and live status

The following records the supplied live validation results, separate from the local checks above:

- Research / quotes: verified live.
- PayBox-hosted ClobAuth EIP-712 signing: verified live.
- PayBox-hosted Deposit Wallet Type-3 order signing: verified live.
- Wallet binding: owner/signing EOA `0x7bdE0dd8acC78f04AAcE3e7b488E369F60a3CB9B`; Deposit Wallet / maker `0xB4BC85B0C28C3d27955c44dAf0Aa2aaf98c78059`.
- After PR #9, a live `submit_order` reached the official Polymarket CLOB and returned HTTP 403 / `PS_CLOB_FORBIDDEN`. No order was created and no funds were spent.
- The exact reason for the hosted CLOB 403 is unproven. Local Indonesia connectivity reports `blocked=false`; the hosted rejection is not proven to be a geoblock.
- Successful fill and cancellation remain **UNVERIFIED**.

No live signing, order submission, or cancellation was performed during this documentation cleanup. Signing success does not establish provider order acceptance or a completed trade.
