# PolyScope — PayBox × Polymarket compatibility spike

Checked: 2026-10-17  
Scope: official hosted PayBox plugin starter 1.0.2. No order submission, cancellation, deposit, or live trading was implemented or attempted.

## Decision

**This hosted plugin cannot execute a real BUY or SELL yet.** It discovers markets, prepares Polymarket CLOB EIP-712 payloads, and can validate a signature supplied after a separate PayBox signing call. It does not derive L2 CLOB credentials, HMAC-authenticate private requests, or POST signed orders. PayBox hosted conformance passing does not prove PayBox signing, Polymarket acceptance, or a live trade.

The official PayBox signing surface is a separate agent tool: `request_wallet_sign` accepts a wallet `credential_id` and `intent.op: "typedData"`, then the agent polls `get_request` for the signature. The hosted plugin cannot call that native tool itself. The PayBox guide documents that plugins run in fresh stateless sandboxes with a 10-second operation budget. [PayBox MCP tool reference](https://docs.paybox.sh/reference/mcp-tools#request_wallet_sign), [PayBox plugin guide](https://developer.paybox.sh/requirements.md)

## Implemented tools

| Tool | Behavior | Validation boundary |
|---|---|---|
| `search_markets` | Searches public Gamma data and returns active binary markets, YES/NO asset IDs, protocol version, order state, and Gamma's `marketRestricted` flag. Uses CTF `clobTokenIds` for v1 and `positionIds` for v2. | Public market discovery only. `marketRestricted` means some jurisdictions are restricted; it does not establish the current user's geoblock result. [Market details](https://docs.polymarket.com/market-data/market-details) |
| `prepare_clob_auth` | Builds the `ClobAuthDomain` EIP-712 payload for Polygon chain 137 and returns the matching PayBox `typedData` intent. | No signature request or L2 credential derivation occurs. [Wallets and authentication](https://docs.polymarket.com/trading/wallets-auth) |
| `prepare_order_signing` | Reads the Gamma market and CLOB book, checks the outcome ID, wallet type, tick size, minimum size, six-decimal amounts, and caller-supplied cap. Emits standard `Order` typed data for EOA/Proxy/Safe and `TypedDataSign` for Deposit Wallets. | It prepares only. BUY `maxAmount` caps the pre-fee pUSD maker amount; SELL caps shares. Fees, account-specific geoblock, balance/allowance, and a freshness threshold are not validated. [Place orders](https://docs.polymarket.com/trading/place-orders) |
| `validate_clob_auth_signature` | Recovers the signer from the exact ClobAuth payload and compares it to the expected address. | Only malformed/invalid signature rejection was locally exercised; no PayBox signature was obtained. |
| `validate_order_signature` | Rebuilds the payload, checks the amounts/cap and recovered signer, and constructs Polymarket's documented ERC-7739 wrapper for a valid Deposit Wallet signature. | Reports `onchainWalletValidation: false`; it does not call ERC-1271 or prove a Deposit Wallet accepts the wrapper. [Place orders](https://docs.polymarket.com/trading/place-orders) |

The bundle contains no order POST, L2 credential output, private key, CLI, backend, database, or persistent service. `src/paybox.ts` and the official starter structure remain unchanged.

## PayBox signing handoff

The intended agent sequence is:

1. Call PayBox `list_credentials`; select an existing EVM wallet credential and compare its public `metadata.address` with the tool's `signingAddress`.
2. Invoke `request_wallet_sign` with that credential ID and the returned `requestWalletSignIntent`. If PayBox returns `pending_approval`, present the approval and poll `get_request` until terminal.
3. Pass the returned signature and original prepared order to `validate_order_signature`. The plugin accepts it only if EIP-712 recovery matches the expected PayBox address.

This gives a potential account-binding check: an EOA uses the same maker and signing address; Proxy/Safe orders use the owner signer separately from the maker; Deposit Wallet order data uses the Deposit Wallet as maker/order signer while PayBox signs with the owner address. The current docs specify these typed-data forms, but no real credential, account, approval screen, or signature was available to prove the complete PayBox-to-Polymarket binding. [PayBox MCP tools](https://docs.paybox.sh/reference/mcp-tools#request_wallet_sign), [Polymarket wallet types](https://docs.polymarket.com/trading/wallets-auth), [Polymarket order signing](https://docs.polymarket.com/trading/place-orders)

For Deposit Wallets, the plugin constructs the documented `TypedDataSign` and ERC-7739 wrapper format. That is a format implementation check only; acceptance by the wallet's ERC-1271 verifier remains untested.

## L2 credentials and stateless sandbox

Polymarket documents L1 ClobAuth signing followed by `/auth/api-key` (create) or `/auth/derive-api-key` (derive). The response includes an API key, secret, and passphrase used for HMAC-authenticated private CLOB requests. These are not the EIP-712 order signature. [Wallets and authentication](https://docs.polymarket.com/trading/wallets-auth), [Place orders](https://docs.polymarket.com/trading/place-orders)

The likely stateless execution shape for a future submit tool is: receive the PayBox-produced ClobAuth signature, derive credentials inside that same invocation, use them only for the subsequent HMAC-authenticated order call, and never log, return, or store them. A separate derive call cannot hand credentials to a later plugin operation because PayBox documents a fresh sandbox for each operation. Its 10-second budget and our four-second request timeout leave a narrow multi-request window, but do not prove production timing. The docs establish no cross-call persistence; they do **not** promise memory zeroization. This spike made no `/auth/api-key` or `/auth/derive-api-key` request because no genuine PayBox signature was available. Credential secrecy and derivation latency therefore remain unproven in hosted execution.

## BUY/SELL payloads, limits, and recovery

Targeted local checks used a real active Gamma market and its public CLOB book, but unsigned payload construction only. For 10 shares at 0.5, BUY encoded 5,000,000 maker units and 10,000,000 taker units; SELL encoded the inverse. Both sides rejected a `maxAmount` of 0.01. Tests also checked ClobAuth chain 137, Deposit Wallet `TypedDataSign` selection, and rejection of a zero/invalid signature. Nonexistent public addresses were supplied only to build unsigned payload shapes; no key or signature was generated, and this is not trade evidence.

The live queries used for directed checks returned v1 markets only. The v2 `positionIds` path follows the current Gamma schema but was not exercised against a live v2 market in this run.

No signed order was POSTed, so no retry or recovery behavior was exercised. Polymarket documents fetching an order by its known ID and reconciling open orders/trades. The public order flow inspected does not document a client idempotency key or a way to query an order by an ID known before its POST response. If a future POST times out before returning an order ID, the safe response is `UNKNOWN`: reconcile authenticated order and trade reads and do not blindly retry. [Manage orders](https://docs.polymarket.com/trading/manage-orders), [Place orders](https://docs.polymarket.com/trading/place-orders)

## Starter file map and checks

All 14 files match the official 1.0.2 manifest. Changed starter paths:

- `src/plugin.ts` — the five tools above.
- `package.json` — name set to `polyscope`; exact `viem@2.51.3` added for EIP-712 recovery and the documented ERC-7739 encoding.
- `pnpm-lock.yaml` — lock update for that dependency; starter pins retained.
- `paybox-plugin.json` — successful sample call is `search_markets` with `{"query":"climate","limit":1}`.

The other ten official files remain unchanged: `src/paybox.ts`, `tsconfig.json`, `pnpm-workspace.yaml`, `.gitignore`, `scripts/conformance.mjs`, `starter-version.json`, `scripts/process.mjs`, `scripts/report.mjs`, `scripts/schema.mjs`, and `scripts/test.mjs`. No extra source/helper files were added.

Checks run with the mandated runtime:

- `pnpm install --frozen-lockfile` — passed with Node.js 24.21.0 and pnpm 11.11.0.
- `pnpm typecheck` — passed.
- `pnpm test` — passed: strict typecheck, two identical builds, and conformance sample `search_markets`; 5 tools discovered. Artifact: 468,995 bytes, SHA-256 `1d2959b997e30398551550b735483f8a93e8fd771bdff637abd5656635238171`.
- Directed no-broadcast checks — BUY, SELL, cap rejection, Deposit Wallet payload shape, and invalid-signature rejection passed.

These are local checks. No hosted PayBox upload or test was run. No PayBox signing call, credential derivation, private CLOB request, transaction, or order broadcast was made.

## Portal configuration for this bundle

Allow these exact HTTPS hosts:

- `gamma-api.polymarket.com`
- `clob.polymarket.com`

No environment variables or API secrets are needed for the implemented public reads and payload preparation. The bundle contains no Polymarket API credential. A future private-order tool would need a separately reviewed same-operation L2 credential lifecycle; it is not part of this artifact.

## Blockers before any live BUY/SELL

1. Exercise PayBox `request_wallet_sign` with an existing Polymarket owner signer and verify credential/address binding, approval presentation, recovered signature, and order acceptance for the actual wallet type.
2. Exercise real ClobAuth L2 credential creation/derivation in a hosted 10-second invocation and prove credentials stay out of output/logs; test HMAC auth without placing an order first.
3. Prove Deposit Wallet ERC-7739 wrapper acceptance by the wallet verifier; local format generation is insufficient.
4. Implement a reviewed private order path with fee-inclusive BUY caps, account-specific geoblock, holdings/balance checks, and stale-data rules. Current `maxAmount` is explicitly pre-fee.
5. Establish safe ambiguous-POST reconciliation and idempotency. Do not retry while the outcome is unknown.
6. Implement and separately validate order status/cancel, portfolio, and PnL tools required by the broader PRD.
7. Pass PayBox hosted checks, then a real eligible-account signing and external user journey. Local conformance is not marketplace approval or live execution.

## Source references

- [PayBox plugin requirements and starter](https://developer.paybox.sh/requirements.md)
- [PayBox MCP wallet signing and plugin orchestration](https://docs.paybox.sh/reference/mcp-tools#request_wallet_sign)
- [Polymarket wallets and CLOB authentication](https://docs.polymarket.com/trading/wallets-auth)
- [Polymarket order signing, amounts, and submission](https://docs.polymarket.com/trading/place-orders)
- [Polymarket market IDs, status, and restrictions](https://docs.polymarket.com/market-data/market-details)
- [Polymarket order reads and reconciliation](https://docs.polymarket.com/trading/manage-orders)
