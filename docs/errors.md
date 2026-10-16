# PolyScope error codes

Errors from public reads include the stable code in the message. Known order-preparation failures return `status: "REJECTED"`, `errorCode`, and a human-readable `reason` as schema-valid structured output, with `submitsOrder: false` and no prepared order or signing intents. Unexpected programming failures remain MCP errors. Execution tools return failures in `errorCode`. `UNAVAILABLE` provider output is a data status, not a successful coverage result.

| Code | Cause | Retry behavior | User-facing explanation |
|---|---|---|---|
| `PS_PROVIDER_UNAVAILABLE` | Polymarket read failed or returned a non-success HTTP status. | Retry a read after checking host access; never retry an ambiguous order submission. | Polymarket data could not be read. |
| `PS_PROVIDER_TIMEOUT` | Polymarket read exceeded its request timeout. | Reads may be retried; a timed-out order POST is `UNKNOWN` and must be reconciled. | Polymarket data did not respond in time. |
| `PS_PROVIDER_INVALID` | Polymarket returned invalid JSON, an invalid preparation market/book schema, invalid or future book timestamp, missing market text, or malformed book numeric data. | Retry after checking provider status; do not prepare an order from malformed data. | Polymarket returned incomplete or unreadable data. |
| `PS_RESPONSE_TOO_LARGE` | A Polymarket response exceeded 1 MiB. | Do not retry unchanged; reduce the requested result size where possible. | The provider response was too large to process. |
| `PS_MARKET_CLOSED` | Market is inactive, closed, restricted, or not accepting orders. | Refresh discovery later; do not submit. | This market is not currently accepting the selected order. |
| `PS_MARKET_UNSUPPORTED` | Required CLOB trading metadata is absent. | Do not submit; use a supported market. | This market does not expose the supported single-market order path. |
| `PS_MARKET_IDENTITY` | Market, outcome asset, condition, or CLOB book does not match. | Re-run discovery and prepare a new order. | The selected outcome could not be matched to the live order book. |
| `PS_MARKET_VERSION` | Gamma and CLOB disagree on exchange version or risk mode. | Do not submit; refresh market metadata. | Polymarket trading metadata changed or conflicts. |
| `PS_FEE_INVALID` | The CLOB market fee descriptor is missing its required shape or exceeds supported precision. | Do not submit; refresh market metadata and confirm the official fee descriptor. | Polymarket's current trading fee could not be verified. |
| `PS_MARKET_CHANGED` | Tick, minimum size, exchange version, or risk mode changed after approval. | Prepare and approve a new order. | Trading constraints changed after approval. |
| `PS_STALE_BOOK` | Refreshed execution book timestamp is invalid or older than 30 seconds. | Fetch a fresh book before submission; never execute an old quote. | The execution order book is stale. |
| `PS_PREPARATION_STALE_BOOK` | Book is older than 120,000 ms at unsigned preparation. | Prepare again from a newer book and obtain new authorization. | The book is too old to prepare an unsigned draft. |
| `PS_PRICE_INVALID` | Price is outside 0–1 or does not match the current tick. | Correct the price and request new approval. | Price does not meet Polymarket's current price increment. |
| `PS_AMOUNT_INVALID` | Amount is not a supported nonnegative decimal string. | Correct the value without exponent notation and retry. | Enter the amount as a nonnegative decimal. |
| `PS_SIZE_BELOW_MINIMUM` | Share size is below the market minimum. | Choose an allowed size and request new approval. | Order size is below the market minimum. |
| `PS_SIZE_INVALID` | Quote size is zero or negative. | Enter a positive share amount. | Quote size must be greater than zero. |
| `PS_AMOUNT_PRECISION` | Amount cannot be encoded at the market's supported precision. | Correct size or price and request new approval. | Order amount exceeds supported precision. |
| `PS_SPENDING_CAP` | Gross order value plus the worst-case fee exceeds the approved cap. | Reduce price or size and request new approval; PolyScope never silently changes either. | The fee-inclusive order exceeds the approved maximum. |
| `PS_NO_MARKETABLE_LIQUIDITY` | No visible level satisfies the approved BUY maximum or SELL minimum. | Refresh the book; any changed order needs new approval. | No current liquidity meets the approved price. |
| `PS_ORDER_INVALID` | Prepared amounts, timestamps, fee rate, or fixed order metadata do not validate. | Discard and prepare a new order. | The prepared order is invalid or expired. |
| `PS_APPROVAL_INVALID` | User execution-approval signature is invalid, expired, or bound to a different order hash or signing address. | Obtain a new PayBox approval for the exact prepared order; do not submit. | This exact FAK order and signer were not approved. |
| `PS_APPROVAL_EXPIRED` | Prepared order or its approval deadline expired. | Prepare and approve a new order. | The order approval has expired. |
| `PS_APPROVAL_STALE` | Fee rate changed after user approval. | Prepare and approve again with the current fee. | Trading fees changed after approval. |
| `PS_SIGNATURE_INVALID` | Order signature does not recover to the approved signer. | Select the matching PayBox credential and sign the exact payload again. | The order signature does not match the approved wallet. |
| `PS_WALLET_BINDING` | Signer, maker, signature type, or order signer does not match the wallet type. | Select the correct existing PayBox wallet and prepare again. | The selected wallet does not match this order. |
| `PS_WALLET_VALIDATION_UNAVAILABLE` | Polygon RPC could not validate an ERC-1271 wallet signature. | Retry only after RPC access is restored; no order was sent. | Smart-wallet signature validation is unavailable. |
| `PS_AUTH_SIGNATURE_INVALID` | ClobAuth signature cannot be recovered. | Prepare and sign a fresh ClobAuth payload. | Polymarket authentication signature is invalid. |
| `PS_AUTH_NONCE_INVALID` | ClobAuth nonce exceeds uint256. | Prepare ClobAuth with an in-range nonce. | Authentication nonce is invalid. |
| `PS_AUTH_WALLET_MISMATCH` | ClobAuth signer differs from the order's PayBox signing address. | Select the same wallet for ClobAuth and order signing. | Authentication and order use different wallets. |
| `PS_AUTH_STALE` | ClobAuth timestamp is older than five minutes. | Prepare and sign fresh ClobAuth data. | Polymarket authentication signature is stale. |
| `PS_DATE_INVALID` | Soccer research date is not a real UTC calendar date in YYYY-MM-DD form. | Correct the date and retry. | Use a valid calendar date. |
| `PS_CLOB_AUTH_FAILED` | CLOB L2 credentials could not be derived or created. | Verify ClobAuth and CLOB access before continuing. | Polymarket trading authentication failed. |
| `PS_CLOB_AUTH_INVALID` | CLOB returned an invalid credential response. | Stop and retry after provider status is confirmed. | Polymarket returned invalid authentication data. |
| `PS_ACCOUNT_STATUS` | CLOB account close-only state could not be verified. | Do not submit until the account status can be read. | Polymarket account trading status is unavailable. |
| `PS_ACCOUNT_CLOSE_ONLY` | CLOB account is close-only and the requested action is BUY. | SELL may be attempted only with a separate explicit user decision and all other checks. | This account is restricted to closing positions. |
| `PS_GEOBLOCKED` | Polymarket geoblock reports the PayBox egress IP as blocked; this does not establish the user's eligibility. | Fail closed; do not bypass the restriction or submit. | Polymarket blocked the PayBox egress IP. This check does not verify user eligibility. |
| `PS_BALANCE_ALLOWANCE` | CLOB balance or allowance could not be read or decoded. | Do not submit until both can be verified. | Wallet balance and exchange allowance could not be verified. |
| `PS_BALANCE` | Balance is below the approved order amount and fee. | Fund through the user's normal Polymarket flow, then re-prepare and re-approve. | Wallet balance is insufficient. PolyScope never deposits. |
| `PS_ALLOWANCE` | Exchange-specific allowance is missing or below the order amount. | User must complete any required approval in Polymarket, then re-prepare; PolyScope never submits approval transactions. | Wallet approval for this exchange is insufficient. |
| `PS_CLOB_REJECTED` | CLOB explicitly rejected the submitted order. | Read order/trade state before deciding on another user-approved order. | Polymarket rejected this FAK order. |
| `PS_SUBMISSION_UNKNOWN` | POST timed out or returned an ambiguous response; bounded read-back did not confirm an authoritative order record or could not run within the remaining budget. | Never resubmit automatically. Check Polymarket orders/trades and reconcile before any new user approval. | Order status is unknown; do not submit it again until reconciled. |
| `PS_ORDER_STATUS_UNKNOWN` | CLOB accepted an order but read-back did not confirm a fill state. | Query status again; do not treat acceptance as a fill. | Order was accepted, but its fill status is not confirmed. |
| `PS_CANCEL_UNKNOWN` | Cancel result and one order read-back were inconclusive. | Do not repeat cancellation blindly; inspect the order record first. | Cancellation status is unknown. |
| `PS_PORTFOLIO_INVALID` | Public positions response did not match the v2 `{ data, pagination }` shape or had inconsistent cursor metadata. | Retry the read after checking the Data API response; continue with the returned cursor when `hasMore` is true. | This positions page could not be decoded. |
| `PS_EXECUTION_BUDGET_EXHAUSTED` | The bounded execution window cannot safely finish preflight while reserving time for one FAK POST and possible read-only reconciliation. | Do not submit or retry; prepare again only after resolving slow dependencies. | There is not enough safe time to submit and reconcile this order. No order was sent. |
| `PS_PREFLIGHT_FAILED` | An unexpected preflight check failed before any order POST. | Review the other status fields and retry only after resolving the preflight issue. | Trading preflight could not complete; no order was sent. |

Football provider failures return `availability: "UNAVAILABLE"` with a provider reason and source timestamps. football-data.org HTTP failures retain safe status-specific reasons: 400 request parameters, 401 token authentication, 403 access or plan permissions, 404 resource, 429 rate limit, and 5xx temporary provider failure. Timeout, invalid JSON, oversized response, and network failures have separate safe reasons. Response bodies and credentials are never included. PolyScope does not substitute incomplete form history or convert a provider failure into coverage.

## Unsigned preparation contract

`prepare_order_signing` returns a discriminated structured result. `status: "PREPARED"` retains the complete existing `preparedOrder`, `requestWalletSignIntent`, `executionApprovalSigningIntent`, `submitsOrder: false`, and `maxNominalIncludesFees: true`. It adds `preparationFreshness: { bookAgeMs, staleAfterMs: 120000 }` outside the signed order. Age is null when a usable timestamp is unavailable. A rejection contains `status: "REJECTED"`, `errorCode`, `reason`, `submitsOrder: false`, and the same freshness metadata, without order or signing intents. Check status before requesting signatures.

Only explicitly enumerated preparation errors are converted to structured rejections. Provider market/book validation is performed at ingestion; internal output validation and unexpected failures are not masked. Invalid fee descriptors retain `PS_FEE_INVALID`. Quote freshness remains 30 seconds. Submission independently re-fetches its book and rejects ages over 30 seconds; the preparation allowance never authorizes execution. Prepared orders and ClobAuth retain their five-minute validity. If human interaction outlasts validity, prepare again and obtain new authorization.

## PayBox registration

The hosted PolyScope contract inspected on 2026-10-17 has a strict, success-only preparation output schema (`additionalProperties: false`). The new discriminated schema is intentionally a registration change: existing success payload fields and signed contents remain usable, but both new success metadata and rejections fail validation against the old persisted schema. The observed `invalid_result: plugin result omitted its declared structured output` is consistent with the old handler throwing an MCP error without structured output while PayBox expects the declared success schema.

After review, rebuild and re-upload the bundle and refresh the hosted tool registration together so PayBox persists the new `tools/list` output schema. Re-discover the contract and verify both PREPARED and REJECTED results against it before accepting the hosted change. No wallet, emoji approval, native signing, hostname, secret, or financial configuration change is required. Local JSON Schema/MCP validation does not establish hosted acceptance; no upload or registration update was performed for this patch.
