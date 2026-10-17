# PolyScope error codes

Known order-preparation failures return `status: "REJECTED"`, `errorCode`, `reason`, `submitsOrder: false`, and book-age metadata, without an order or signing intent. Unexpected programming failures remain MCP errors. `UNAVAILABLE` provider output is a data status, not successful coverage.

| Code | Cause | Retry behavior | User-facing explanation |
|---|---|---|---|
| `PS_PROVIDER_UNAVAILABLE` | Polymarket read failed or returned a non-success HTTP status. | Retry a read after checking host access; reconcile an ambiguous order before any new submission. | Polymarket data could not be read. |
| `PS_PROVIDER_TIMEOUT` | Polymarket read exceeded its per-request timeout. | Reads may be retried; a timed-out order POST is `UNKNOWN` and must be reconciled. | Polymarket data did not respond in time. |
| `PS_PROVIDER_INVALID` | Invalid JSON, market/book shape, or numeric market data required to construct the request. | Check provider status; do not prepare from malformed market data. | Polymarket returned incomplete or unreadable data. |
| `PS_RESPONSE_TOO_LARGE` | A Polymarket response exceeded 1 MiB. | Reduce the requested result size where possible. | The provider response was too large to process. |
| `PS_CLOB_TIME_UNAVAILABLE` | The CLOB server-time endpoint did not return a successful response. | Retry preparation after CLOB access is available; no local-clock fallback is used. | CLOB server time could not be read. |
| `PS_CLOB_TIME_INVALID` | The CLOB server-time response was not a positive Unix timestamp in seconds. | Stop and check provider status. | CLOB returned an invalid server timestamp. |
| `PS_MARKET_CLOSED` | Market is inactive or closed. | Refresh discovery later. | This market is not active. |
| `PS_MARKET_UNSUPPORTED` | Required CLOB trading metadata is absent, the market is not accepting orders, or redemption metadata does not identify a supported binary CTF/V2 route. | Use a supported market. | This market does not expose a supported order or redemption path. |
| `PS_MARKET_IDENTITY` | Market, outcome asset, condition, or CLOB book does not match. | Re-run discovery and prepare a new order. | The selected outcome could not be matched to the live order book. |
| `PS_MARKET_VERSION` | Gamma and CLOB disagree on exchange version or risk mode. | Refresh market metadata before preparing or submitting. | Polymarket trading metadata conflicts. |
| `PS_MARKET_CHANGED` | Exchange version or risk mode changed after preparation, so the signed exchange domain is no longer compatible. | Prepare and sign a new order for the current exchange domain. | The market's exchange signing domain changed. |
| `PS_FEE_INVALID` | The current CLOB fee descriptor is invalid or exceeds supported precision. | Check provider status before proceeding. | Polymarket's current trading fee could not be read. |
| `PS_PRICE_INVALID` | Price is outside 0–1 or does not match the current tick. | Correct the price. | Price does not meet Polymarket's current price increment. |
| `PS_AMOUNT_INVALID` | Amount is not a supported nonnegative decimal string. | Correct the value without exponent notation. | Enter the amount as a nonnegative decimal. |
| `PS_SIZE_BELOW_MINIMUM` | Share size is below the market minimum. | Choose a size at or above the market minimum. | Order size is below the market minimum. |
| `PS_SIZE_INVALID` | Quote size is zero or negative. | Enter a positive share amount. | Quote size must be greater than zero. |
| `PS_AMOUNT_PRECISION` | Amount cannot be encoded at the market's supported precision. | Correct size or price to a supported precision. | Order amount exceeds supported precision. |
| `PS_SPENDING_CAP` | Gross value plus the current conservative fee amount exceeds the user's all-in cap. | Choose a lower size or price and prepare a new order. PolyScope does not silently resize it. | The fee-inclusive order exceeds the approved maximum. |
| `PS_ORDER_INVALID` | Prepared order fields, precision, timestamp, or fixed metadata do not validate. | Discard and prepare a new order. | The prepared order is invalid. |
| `PS_SIGNATURE_INVALID` | Polymarket Order signature does not recover to the selected signer. | Select the matching PayBox wallet and sign the exact order payload again. | The order signature does not match the selected wallet. |
| `PS_WALLET_BINDING` | Signer, maker, signature type, or order signer does not match the wallet type. | Select the matching existing PayBox wallet and prepare again. | The selected wallet does not match this order. |
| `PS_AUTH_SIGNATURE_INVALID` | ClobAuth signature cannot be recovered. | Prepare and sign a fresh ClobAuth payload. | Polymarket authentication signature is invalid. |
| `PS_AUTH_NONCE_INVALID` | ClobAuth nonce exceeds uint256. | Prepare ClobAuth with an in-range nonce. | Authentication nonce is invalid. |
| `PS_AUTH_WALLET_MISMATCH` | ClobAuth signer differs from the selected owner EOA. | Prepare and sign a new ClobAuth for the selected owner EOA. | Authentication and order use different owner signers. |
| `PS_DATE_INVALID` | Soccer research date is not a real UTC calendar date in YYYY-MM-DD form. | Correct the date. | Use a valid calendar date. |
| `PS_CLOB_AUTH_FAILED` | CLOB L2 credentials could not be derived or created. | Verify ClobAuth and CLOB access. | Polymarket trading authentication failed. |
| `PS_CLOB_AUTH_REJECTED` | The CLOB rejected an L1 ClobAuth request with HTTP 401. | Prepare and sign a new ClobAuth, then retry explicitly. PolyScope does not sign or replay it. | Polymarket rejected ClobAuth; sign a fresh payload. |
| `PS_CLOB_AUTH_INVALID` | CLOB returned an invalid credential response. | Stop and check provider status. | Polymarket returned invalid authentication data. |
| `PS_CLOB_PRIVATE_AUTH_REJECTED` | The CLOB rejected an authenticated L2 order, status, or cancellation request with HTTP 401. | Verify the derived CLOB credentials and owner EOA before another request. | Polymarket rejected L2 CLOB authentication. |
| `PS_CLOB_FORBIDDEN` | The CLOB denied a private order or cancellation request with HTTP 403. | Check account access and official Polymarket restrictions. | Polymarket denied this CLOB request. |
| `PS_CLOB_REQUEST_REJECTED` | The CLOB rejected a private read or request with a client error other than 400, 401, or 403. | Check the order ID, request, and account access. | Polymarket rejected this CLOB request. |
| `PS_GEOBLOCKED` | Official Polymarket geoblock response reports `blocked: true`. | Do not bypass the restriction or submit. | Polymarket reports this request as blocked. |
| `PS_CLOB_REJECTED` | CLOB explicitly rejected a private request with HTTP 400 or returned an order-level rejection. | Read order/trade state before deciding on any new user-approved order. | Polymarket rejected this CLOB request. |
| `PS_SUBMISSION_UNKNOWN` | POST timed out, returned HTTP 408/429/5xx, or returned a malformed/unconfirmed success response, and one read-only reconciliation did not confirm an outcome. | Never resubmit automatically. Reconcile in Polymarket before any new approval. | Order status is unknown; do not submit it again until reconciled. |
| `PS_ORDER_STATUS_UNKNOWN` | CLOB order read-back did not confirm a status. | Query status again; do not treat acceptance as a fill. | Order fill status is not confirmed. |
| `PS_ORDER_NOT_FOUND` | CLOB returned HTTP 404 for the requested order ID. | Confirm the order ID; a missing record does not prove an earlier submission was rejected. | Polymarket returned no record for this order ID. |
| `PS_CANCEL_UNKNOWN` | Cancel result was ambiguous and one read-only order read-back did not confirm the outcome. | Inspect the order before another cancellation request. PolyScope never repeats DELETE automatically. | Cancellation status is unknown. |
| `PS_PORTFOLIO_INVALID` | Public positions response did not match the v2 shape or cursor metadata. | Retry the read after checking the Data API response. | This positions page could not be decoded. |
| `PS_MARKET_NOT_FOUND` | Gamma returned no exact market match for the supplied redemption condition ID. | Verify the condition ID against Polymarket's market record. | No matching Polymarket market was returned. |
| `PS_MARKET_DATA_UNAVAILABLE` | Gamma market metadata could not be read while preparing a redemption preview. | Retry the read after checking Gamma availability. | Polymarket market metadata is unavailable. |
| `PS_CHAIN_READ_UNAVAILABLE` | A bounded Polygon RPC read for balance, approval, or on-chain resolution failed or timed out. | Retry the read; the affected value remains UNKNOWN until confirmed. | Polygon state could not be verified. |
| `PS_PREFLIGHT_FAILED` | A provider or credential failure stopped execution before the order POST. | Resolve the reported provider or authentication issue first. | Trading preflight could not complete; no order was sent. |

## Preparation and execution

`prepare_order_signing` returns `status: "PREPARED"` with the Polymarket Order payload, one `requestWalletSignIntent`, `submitsOrder: false`, and `preparationFreshness: { bookAgeMs }`. Book age is informational; there is no 120-second preparation cutoff. `get_quote` labels books older than 30 seconds as `STALE`, but that label does not block preparation or submission. A future, invalid, or unavailable book timestamp does not independently block a price-bounded FAK order.

PayBox handles human approval and wallet signing through `request_wallet_sign` and `get_request`. The Polymarket Order signature signs the exact market token, side, price-derived amounts, size, wallet, exchange domain, and FAK request. ClobAuth is a separate Polymarket L1 operation used to derive L2 credentials; it is not a PolyScope execution approval. No custom ExecutionApproval payload, signature, or deadline is used.

BUY maker/taker amounts encode the exact selected price and share size. Current fee metadata is checked against the all-in cap before one order POST. The adapter does not call the SDK's `maxSpend` order resizer because that API changes the signed BUY amount, which would conflict with the selected share size; if the exact signed size exceeds the cap, preparation or submission rejects it instead of resizing silently. Polymarket remains responsible for account balance, allowance, and other exchange constraints.

The adapter has per-request network timeouts and no custom total execution budget. A POST that may have reached CLOB is never retried automatically; the adapter makes at most one read-only order-hash reconciliation. An unresolved result is returned as `UNKNOWN`.

## Classification of local trading rejections

Each local trade rejection is assigned to one of the three requested classes. Provider, transport, and credential failures are operational failures that prevent request construction or completion; they are not eligibility decisions or trading-policy rejections.

| Classification | Remaining codes and checks | Reason |
|---|---|---|
| Official Polymarket protocol requirement | `PS_MARKET_CLOSED`, `PS_MARKET_UNSUPPORTED`, `PS_MARKET_VERSION`, `PS_MARKET_CHANGED`, `PS_AMOUNT_PRECISION`, `PS_PRICE_INVALID`, `PS_SIZE_BELOW_MINIMUM`, `PS_ORDER_INVALID`, `PS_SIGNATURE_INVALID`, `PS_WALLET_BINDING`, `PS_AUTH_SIGNATURE_INVALID`, `PS_AUTH_NONCE_INVALID`, `PS_AUTH_WALLET_MISMATCH`, `PS_CLOB_REJECTED`, `PS_GEOBLOCKED` | The order must target an accepting market, use a compatible exchange domain and current tick/minimum, encode exact amounts, and carry an order signature and wallet binding that Polymarket accepts. Official geoblock responses are honored. For smart wallets, local signer recovery is checked; CLOB contract-wallet acceptance is not claimed locally. |
| Exact user-approved order constraint | `PS_MARKET_IDENTITY`, `PS_AMOUNT_INVALID`, `PS_SIZE_INVALID`, `PS_SPENDING_CAP` | Keep the selected market/outcome and decimal inputs exact, and do not exceed the user-specified fee-inclusive cap. The adapter never resizes or silently re-signs an order. |
| Redundant/custom PolyScope policy | None | No remaining local trade rejection is based solely on Gamma `restricted`, quote liquidity, book age/timestamp, changed-but-still-valid tick/minimum metadata, or a separate ERC-1271 RPC read. `get_quote` reports liquidity and freshness; CLOB remains authoritative for contract-wallet acceptance. |

Operational failures, not policy classifications: `PS_FEE_INVALID`, `PS_CLOB_TIME_UNAVAILABLE`, `PS_CLOB_TIME_INVALID`, `PS_CLOB_AUTH_FAILED`, `PS_CLOB_AUTH_REJECTED`, `PS_CLOB_AUTH_INVALID`, `PS_CLOB_PRIVATE_AUTH_REJECTED`, `PS_CLOB_REQUEST_REJECTED`, `PS_ORDER_NOT_FOUND`, `PS_PROVIDER_UNAVAILABLE`, `PS_PROVIDER_TIMEOUT`, `PS_PROVIDER_INVALID`, `PS_RESPONSE_TOO_LARGE`, and `PS_PREFLIGHT_FAILED` mean required metadata, authentication, or provider access failed. They do not claim the user or account is ineligible.

`PS_SUBMISSION_UNKNOWN`, `PS_ORDER_STATUS_UNKNOWN`, and `PS_CANCEL_UNKNOWN` describe unresolved provider outcomes after a request, not pre-submission local gates. `PS_DATE_INVALID` and `PS_PORTFOLIO_INVALID` concern non-trading tools.

### ClobAuth timestamp finding

Polymarket's official [wallets and authentication guide](https://docs.polymarket.com/trading/wallets-auth) specifies a Unix-seconds ClobAuth timestamp without an accepted-age window. The [CLOB server-time endpoint](https://docs.polymarket.com/api-reference/data/get-server-time) returns server Unix time for client synchronization, so `prepare_clob_auth` uses it instead of the host clock. No local signature-age cutoff is applied because the accepted interval is undocumented. If credential creation or derivation returns HTTP 401, PolyScope fails closed with `PS_CLOB_AUTH_REJECTED`; the host must prepare and sign a new payload explicitly. Local signature recovery does not establish timestamp freshness or CLOB acceptance.

The official [Order format](https://docs.polymarket.com/trading/place-orders) includes a signed Unix-millisecond timestamp, but documents no five-second future tolerance or local freshness cutoff. PolyScope still requires a positive, safely representable integer for the signed/order JSON field, but leaves age acceptance to the CLOB. The documentation describes book timestamp as metadata; no local timestamp-age or clock-skew rejection is used.

### Smart-wallet signature finding

PolyScope recovers the supplied EIP-712 signature to the selected signing address and constructs the official Deposit Wallet ERC-7739 wrapper where required. It does not call `polygon-rpc.com` to preflight ERC-1271. `validate_order_signature` now returns `localSignerVerified` and `contractWalletAcceptance` (`NOT_APPLICABLE` for EOA, `DEFERRED_TO_CLOB` for contract wallets); it does not claim contract validation. Polymarket's order-placement response remains authoritative for contract-wallet acceptance. The [official order guide](https://docs.polymarket.com/trading/place-orders) documents wallet signature types, Deposit Wallet wrapping, and checking CLOB acceptance; the [wallet authentication guide](https://docs.polymarket.com/trading/wallets-auth) describes Polymarket's signer/auth flows.

### Current constraint changes

At submission, the adapter checks the exact signed price against the current book tick and exact signed share size against the current minimum. A changed value is not itself a rejection. If either exact value is now invalid, submission stops without modifying or re-signing the order. A changed exchange version or neg-risk mode remains a rejection because it changes the exchange signing domain.

Soccer provider failures return `availability: "UNAVAILABLE"` with a provider reason and source timestamps. HTTP errors retain safe status-specific reasons. Response bodies and credentials are never included. PolyScope does not substitute incomplete form history or convert provider failure into coverage.

`get_trading_readiness` is a read-only snapshot of the caller-selected account wallet. EOA allowlist eligibility and amount-specific balance sufficiency remain `UNKNOWN` unless an authoritative check is available. `prepare_redeem` returns transaction calldata only after on-chain resolution and position balances are verified; it never signs or broadcasts, and a prepared route reports `EXTERNAL_ACTION_REQUIRED`.
