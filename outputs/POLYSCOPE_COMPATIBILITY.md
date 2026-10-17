# PR #7 — thin PayBox + official Polymarket SDK adapter

Checked 2026-10-17, Asia/Jakarta. This report includes the PR #7 execution-path simplification and final local validation. The final Git commit carries this report. No merge, upload, deployment, or live wallet signing was performed.

## 1. Main and PR head

- Canonical Draft PR: [#7](https://github.com/riyannode/polyscope/pull/7), branch `fix/clob-auth-recovery`.
- Main at start and final remote read: `cd032a8b3f1a19268c4892b13c3ce2d102825ddf`.
- PR #7 original head for this task: `4fa9860b2ac852e8e90f811934c181c77ae4552a`.
- PR #7 final commit: this report's Git commit.
- Local checkout: `/home/acer/codex-tasks/2026-10-17/di/work/polyscope-pr7`.
- PR #8 remains Draft at `7fa517d60c89875e0d9d2cd007eceb7a8954ece4`; this task made no changes to it and did not merge or cherry-pick it.

## 2. Main movement

No advancement was observed across the initial and final live GitHub/ref reads. PR #7's base matches main, so no main integration was necessary. An empty combined-status result was not used as validation evidence.

## 3. Exact repository files changed

- `README.md`
- `docs/errors.md`
- `scripts/conformance.mjs`
- `src/plugin.ts`
- `tests/network-fixtures.mjs`
- `outputs/POLYSCOPE_COMPATIBILITY.md`
- `outputs/plugin.mjs`

These are the seven files changed by this finalization task. Dependency manifests and patches are unchanged.

`src/paybox.ts`, `starter-version.json`, the safe `search_markets` sample in `paybox-plugin.json`, and the research skill remain unchanged. No repository or ancestor `AGENTS.md` was found; the task's supplied instructions were applied. Soccer research implementation, probability/edge functions, and research tool definitions were compared against HEAD and are unchanged.

## 4. Custom protocol implementation removed

Removed manual ClobAuth field construction, L1 headers and credential HTTP requests, HMAC/L2 signing, `l2Signature`, `clobPrivateRequest`, authenticated GET/DELETE and `/order` wire bodies, exchange/domain address tables, `DOMAIN_BY_MARKET`, `TICK_RULES`, salt generation, order typed-data construction, broad Polygon contract scanning, position-ID decoding, redemption ABIs, calldata encoding and route-address inventories.

`src/plugin.ts`: **3,177 → 2,785 lines**, net **392 fewer**. The removed protocol identifiers and contract/calldata helpers are absent. Research was not redesigned.

## 5. Small compatibility/product code that remains

- External signer callbacks expose SDK-generated unsigned authentication data and refuse all actual signing/message signing/transaction sends. The SDK public preparation workflows require an authenticated client, which explains the schema changes below.
- A stateless finalizer reattaches the saved SDK-generated EIP-712 fields and PayBox signature to the SDK `SignedOrder` interface. A local field-by-field check proves that the wire order matches the saved signed payload; submission does not generate a second order or refresh market metadata.
- Owner Deposit Wallet signatures use a short ERC-7739 envelope made from the saved SDK types/domain and generic viem hashes. A regression compares it byte-for-byte with the official SDK's completed preparation workflow. No private SDK implementation is copied or deep-imported. Session-key wallet signing is explicitly unsupported by this finalizer.
- The order preparation contract contains no enforced spending-cap fields. SDK maker/taker amounts and effective rounded size are presented for PayBox approval. `fetchMarketInfo` remains for informational quote fee estimates only; fees are not refreshed after signing and do not block submission.
- Small public Gamma/book adapters retain quote provenance and raw timestamp/version diagnostics absent from SDK-normalized book output. They do not construct orders or choose exchange addresses.
- A scoped HTTP adapter prevents another transmission of a non-read request within one SDK operation, including SDK DELETE retries, and retains the first mutation response status. Successful HTTP statuses are observed rather than inferred. It neither implements auth/HMAC nor builds CLOB request bodies.
- A pnpm patch corrects two invalid mapped-type references in the published bindings declaration. It changes no SDK runtime code, adds no `skipLibCheck`, and retains the starter's TypeScript version. The same upstream declaration errors were reproduced under TypeScript 5.9.3 and 6.0.2 before choosing the declaration-only correction.

## 6. Official SDK APIs used

Exact dependencies: `@polymarket/client@0.13.0`, `@polymarket/bindings@0.13.0`, `@polymarket/types@0.2.0`. Only public package entrypoints are imported.

| Responsibility | SDK API |
|---|---|
| Auth payload, wallet classification, secure client and L2 auth | `createPublicClient`, `createSecureClient` |
| Invocation-local credentials | `createOrDeriveApiKey` |
| Informational quote fee metadata | `fetchMarketInfo` |
| Amount rounding, salt, tick rules, protocol/exchange routing and signing data | `prepareLimitOrder` |
| Wire formatting and POST | `client.postOrder` |
| Authenticated order reads | `client.fetchOrder` |
| Cancellation | `client.cancelOrder` |
| Read-only indexed approvals | `client.fetchTradingApprovalsState` |
| Position/market state | `client.listPositions`, `client.listMarkets` |
| Unsigned redemption calls | `prepareRedeemMarketPositions`, `prepareRedeemPosition` |

The SDK limit-order workflow supplies the signed order fields; SDK-rounded effective quantities are shown to PayBox for approval. The trusted prepared approval context binds FAK/FOK because order type is posted separately from the EIP-712 Order. Visible depth never determines FOK success. FAK may partially fill.

## 7. PayBox responsibilities

Wallet choice, wallet credentials/grants, policy, approval mode/UI, actual signing, transaction validation/simulation, broadcasting and confirmation remain outside PolyScope. No wallet IDs, private keys, credential vault, wallet manager, persistent CLOB store or approval engine were added. The plugin never calls `reopen_signing_window`, funds wallets, approves tokens, or broadcasts. Credentials are discarded with the invocation and never appear in MCP output.

## 8. Normal ClobAuth and FAK/FOK flow

```text
prepare_clob_auth → PayBox signs ClobAuth once
prepare_order_signing(FAK, clobAuth) → PayBox signs exact FAK Order → submit_order(FAK, clobAuth)
prepare_order_signing(FOK, same clobAuth) → PayBox signs exact FOK Order → submit_order(FOK, same clobAuth)
```

Each order gets its own prepared payload and Order signature. `validate_clob_auth_signature` and `validate_order_signature` are optional diagnostics. Each authenticated invocation uses SDK `createOrDeriveApiKey` (create first; derive only after HTTP 400); no API key, secret or passphrase is returned or persisted. Provider authentication rejection requires explicit fresh authentication; preparing another order does not request a new ClobAuth signature.

Schema changes: `prepare_order_signing` adds required `clobAuth`; `prepare_redeem` adds required `signingAddress` and `clobAuth`. The public SDK requires a secure client for these workflows. The public SDK nonce is limited to a nonnegative JavaScript-safe integer. README and conformance fixtures describe these changes.

## 9. Polygon proposals and redemption

**Polygon PayBox proposal validation support is UNVERIFIED.** The [PayBox requirements](https://developer.paybox.sh/requirements.md) specify canonical EVM chain syntax and require an available PayBox network, but do not establish Polygon validation availability. Syntax acceptance by `src/paybox.ts` is not host support. No validation/signing/transaction was attempted to manufacture proof, and no `io.paybox/transactionProposal` is emitted for this route.

Redemption returns a read-only SDK-generated EOA unsigned preview with `EXTERNAL_ACTION_REQUIRED`. SDK indexed positions must match the exact owner, condition and SDK market assets and be marked redeemable. Indexed state is not fresh chain finality; resolution/route approvals remain UNKNOWN when the SDK cannot establish them. V2 held outcomes are prepared separately with SDK chain-read amounts, preserving multiple calls without pretending a prior transaction executed.

Gasless SAFE/PROXY/Deposit Wallet redemption returns `UNSUPPORTED` plus `EXTERNAL_ACTION_REQUIRED`: its public SDK workflow requires relayer authorization/signing before direct calls can be exposed. No alternate wallet/relayer runtime or signing authority was added. EOA and owner Deposit Wallet order signing remain covered separately. If Polygon proposal support is established later, `src/paybox.ts` remains the standard proposal helper; its starter implementation was preserved unchanged.

## 10. Tool catalog

All **16 public names** remain:

- `search_markets`
- `get_quote`
- `get_soccer_news`
- `research_soccer`
- `analyze_soccer_edge`
- `prepare_clob_auth`
- `prepare_order_signing`
- `validate_clob_auth_signature`
- `validate_order_signature`
- `submit_order`
- `submit_fak_order`
- `get_order_status`
- `cancel_order`
- `get_trading_readiness`
- `prepare_redeem`
- `get_portfolio`

`submit_order` is canonical; `submit_fak_order` is the FAK compatibility wrapper. The accompanying generated local catalog documents current schemas; it is not persisted/hosted PayBox discovery evidence.

## 11. Validation

Executed with **Node 24.21.0 / pnpm 11.11.0 / Linux x64**, starter **1.0.2**:

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS (exit 0; already up to date) |
| `pnpm typecheck` | PASS (exit 0; also run by `pnpm test`) |
| `pnpm test` | PASS (exit 0; 188.5 seconds; includes two builds and all deterministic fixtures) |
| `pnpm conformance` | PASS (exit 0; 16 tools discovered; read-only provider sample below) |
| `pnpm audit --prod` | PASS (exit 0; no known vulnerabilities) |
| `pnpm build` twice | PASS (exit 0; identical byte count and SHA-256) |
| `git diff --check` | PASS (exit 0) |

Regression coverage includes discovery with no network access; self-contained schemas; complete typed data in text-only output; SDK effective amount presentation; local rejection of signed-field mutation; EOA type 0; owner Deposit Wallet type 3 and an SDK byte-for-byte signature oracle; reusable ClobAuth; optional validators; no post-sign Gamma/book/fee refresh; provider-owned minimum-size rejection; FAK/FOK approval-context binding; order-ID read-back matching; one POST/DELETE with read-only ambiguity reconciliation; no secret output; informational readiness; SDK CTF/V2 unsigned redemption; and unchanged research regressions.

Resolved setup failures: the initial `pnpm test` baseline returned `startup_failed` because the task-local pnpm shim was not executable; its executable permission was corrected and validation rerun. Initial `pnpm typecheck` reported upstream bindings TS2536 errors under both tested TypeScript versions; the declaration-only patch above resolves them. No final validation command remains failed or unavailable.

Production audit: **no known vulnerabilities found**. Local conformance discovered 16 tools. Live read-only sample: `search_markets`, `get_soccer_news`, and `get_quote` passed; the quote was FRESH. football-data.org and API-Football returned HTTP 403, so soccer API availability was UNAVAILABLE. Live authenticated preparation was not run because it requires signed ClobAuth. Fixture success is not live wallet/provider execution proof.

Starter manifest checks match `starter-version.json`, `src/paybox.ts`, `scripts/process.mjs`, `scripts/report.mjs`, `scripts/schema.mjs`, `tsconfig.json` and `.gitignore`. The existing custom test runner remains unchanged. No starter release files were mixed.

## 12. Bundle

- Bytes: **1,341,564**, below **10,485,760** (10 MiB).
- SHA-256: `fe1ab83d52ad25d59cc83b7d0201424e1928e87283070ff0a402581fe7a9bbcf`.
- Both final builds have identical bytes and SHA-256.
- `dist/plugin.mjs` and tracked `outputs/plugin.mjs` are byte-identical, confirmed with `cmp` and SHA-256.
- The bundle remains local; it was not uploaded or installed.

## 13. Remaining hosted E2E blockers and cleanup

Hosted acceptance remains **UNVERIFIED** for the rebuilt catalog, new signed-material arguments, PayBox nested typed-data signing handoff/grant binding, real ClobAuth reuse, authenticated provider acceptance, actual FAK/FOK fills/status/cancel, wallet eligibility/funding/approvals and redemption execution. `get_trading_readiness` honestly leaves funding, gas, per-order sufficiency and EOA eligibility UNKNOWN. No live trade or receipt is claimed.

The SDK uses read-only `relayer-v2.polymarket.com` deployment-state checks for supported contract wallets; a future hosted test must verify that host is allowed. No live host configuration or grants were changed here. Polygon proposal validation and gasless redemption require the external capabilities described above. The hosted ten-second budget and brokered soccer credential delivery also require hosted verification.

Only finite CLI/MCP validation children were started; starter lifecycle handling stopped them. No persistent server, watcher, tunnel, daemon or listener was created, so no persistent-process cleanup was required.

Sources: [official TypeScript SDK](https://github.com/Polymarket/ts-sdk), [PayBox plugin requirements and starter 1.0.2](https://developer.paybox.sh/requirements.md). SDK source inspection was checked against the installed published package, not assumed from the repository's latest branch.

## Credential boundary correction

The installed SDK's `createOrDeriveApiKey` remains responsible for create-first / HTTP-400-then-derive credential handling. The final submission runs this SDK authentication setup in parallel with the standalone geoblock request, then posts exactly once through `client.postOrder`. Fixture assertions cover both fresh and existing credential paths, blocked geolocation, exact signed-wire fields, no post-sign Gamma/book/fee requests, and one mutation with read-only reconciliation after ambiguity.

### Execution-path finalization

- Deleted `validateExecutionSnapshot()` and removed its Gamma, CLOB book, fee, tick, minimum-size, market-version, and spending checks from submission. Its geoblock request is isolated in `checkGeoblock()`.
- Deleted `assertSdkBinding()` and does not call `sdkOrderPayload()` after signing. The only `sdkOrderPayload()` call is in preparation; submission locally reconstructs `SignedOrder` and checks every signed field before calling `postOrder()`.
- `validatePreparedOrder()` now checks safe serialization and equality between the saved typed data and prepared order fields. PayBox signature recovery, expected signer binding, FAK/FOK context, and exact wire-field binding remain local checks.
- Removed `maxNominalPusd`, `maxGrossPusd`, `maxFeePusd`, fee-rate/exponent fields, and market eligibility metadata from the preparation contract. Quote fee calculation remains informational.
- The standalone geoblock request uses the official Polymarket endpoint and runs alongside SDK credential setup. SDK financial requests have no locally imposed 1.5-second timeout; caller cancellation is preserved and redirects are rejected.
- Approximate call-graph comparison from the audited EOA create-success path: preparation **7 requests / 6 sequential stages → about 5 / 4**; submission including POST **9 / 5 → about 4 / 3**. These are architecture estimates, not hardcoded fixture assertions. Current preparation retains one product-mapping Gamma read and the SDK credential/order-preparation requests. Submission has parallel credential/geoblock work, one POST, and only on ambiguity one read-only order lookup.
- Order status and ambiguous submission reconciliation reject a returned provider order ID when it differs from the requested order ID. Omitted provider IDs are not fabricated.
- FAK/FOK remains bound to the trusted prepared context. FAK partial fills and FOK provider results are reflected from authoritative read-back; visible depth and local minimum-size rules do not gate the order.
- Static source search found no `validateExecutionSnapshot`, `assertSdkBinding`, custom HMAC/L2 signer, custom domain/tick routing tables, Polygon approval scanner, short financial timeout, or post-sign Gamma/book/fee refresh. `/order` remains only as SDK-owned calls in plugin code and HTTP fixture routes in tests. `feeMicros` remains only for informational quotes; `PS_AMOUNT_PRECISION` remains for read-only quote parsing.

No live ClobAuth signing, order submission, cancellation, funding, approval, or redemption was performed. Hosted wallet/provider acceptance remains unverified as described above.
