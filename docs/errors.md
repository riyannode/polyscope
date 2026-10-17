# PolyScope error codes

Known order-preparation failures return `status: "REJECTED"`, `errorCode`, `reason`, `submitsOrder: false`, and book-age metadata, without an order or signing intent. Unexpected programming failures remain MCP errors. `UNAVAILABLE` provider output is a data status, not successful coverage.

| Code | Cause | Retry behavior | User-facing explanation |
|---|---|---|---|
| `PS_PROVIDER_UNAVAILABLE` | Polymarket read failed or returned a non-success HTTP status. | Retry a read after checking host access; reconcile an ambiguous order before any new submission. | Polymarket data could not be read. |
| `PS_PROVIDER_TIMEOUT` | Polymarket read exceeded its per-request timeout. | Reads may be retried; a timed-out order POST is `UNKNOWN` and must be reconciled. | Polymarket data did not respond in time. |
| `PS_PROVIDER_INVALID` | Invalid JSON, market/book shape, book timestamp, or numeric market data. | Check provider status; do not prepare from malformed data. | Polymarket returned incomplete or unreadable data. |
| `PS_RESPONSE_TOO_LARGE` | A Polymarket response exceeded 1 MiB. | Reduce the requested result size where possible. | The provider response was too large to process. |
| `PS_MARKET_CLOSED` | Market is inactive or closed. | Refresh discovery later. | This market is not active. |
| `PS_MARKET_UNSUPPORTED` | Required CLOB trading metadata is absent or the market is not accepting orders. | Use a supported market. | This market does not expose the supported single-market order path. |
| `PS_MARKET_IDENTITY` | Market, outcome asset, condition, or CLOB book does not match. | Re-run discovery and prepare a new order. | The selected outcome could not be matched to the live order book. |
| `PS_MARKET_VERSION` | Gamma and CLOB disagree on exchange version or risk mode. | Refresh market metadata before preparing. | Polymarket trading metadata conflicts. |
| `PS_MARKET_CHANGED` | Tick, minimum size, exchange version, or risk mode changed after preparation. | Prepare again using current constraints. | Trading constraints changed after preparation. |
| `PS_FEE_INVALID` | The current CLOB fee descriptor is invalid or exceeds supported precision. | Check provider status before proceeding. | Polymarket's current trading fee could not be read. |
| `PS_PRICE_INVALID` | Price is outside 0–1 or does not match the current tick. | Correct the price. | Price does not meet Polymarket's current price increment. |
| `PS_AMOUNT_INVALID` | Amount is not a supported nonnegative decimal string. | Correct the value without exponent notation. | Enter the amount as a nonnegative decimal. |
| `PS_SIZE_BELOW_MINIMUM` | Share size is below the market minimum. | Choose a size at or above the market minimum. | Order size is below the market minimum. |
| `PS_SIZE_INVALID` | Quote size is zero or negative. | Enter a positive share amount. | Quote size must be greater than zero. |
| `PS_AMOUNT_PRECISION` | Amount cannot be encoded at the market's supported precision. | Correct size or price to a supported precision. | Order amount exceeds supported precision. |
| `PS_SPENDING_CAP` | Gross value plus the current conservative fee amount exceeds the user's all-in cap. | Choose a lower size or price and prepare a new order. PolyScope does not silently resize it. | The fee-inclusive order exceeds the approved maximum. |
| `PS_NO_MARKETABLE_LIQUIDITY` | No visible level meets the selected price bound during preparation. | The user may refresh the quote and decide whether to prepare again. | No visible liquidity meets the selected price. |
| `PS_ORDER_INVALID` | Prepared order fields, precision, timestamp, or fixed metadata do not validate. | Discard and prepare a new order. | The prepared order is invalid. |
| `PS_SIGNATURE_INVALID` | Polymarket Order signature does not recover to the selected signer. | Select the matching PayBox wallet and sign the exact order payload again. | The order signature does not match the selected wallet. |
| `PS_WALLET_BINDING` | Signer, maker, signature type, or order signer does not match the wallet type. | Select the matching existing PayBox wallet and prepare again. | The selected wallet does not match this order. |
| `PS_WALLET_VALIDATION_UNAVAILABLE` | Polygon RPC could not validate an ERC-1271 wallet signature. | Retry after RPC access is restored; no order was sent. | Smart-wallet signature validation is unavailable. |
| `PS_AUTH_SIGNATURE_INVALID` | ClobAuth signature cannot be recovered. | Prepare and sign a fresh ClobAuth payload. | Polymarket authentication signature is invalid. |
| `PS_AUTH_NONCE_INVALID` | ClobAuth nonce exceeds uint256. | Prepare ClobAuth with an in-range nonce. | Authentication nonce is invalid. |
| `PS_AUTH_WALLET_MISMATCH` | ClobAuth signer differs from the order's signing address. | Use the same wallet for ClobAuth and order signing. | Authentication and order use different wallets. |
| `PS_AUTH_STALE` | ClobAuth timestamp is outside Polymarket's accepted window. | Prepare and sign fresh ClobAuth data. | Polymarket authentication signature is stale. |
| `PS_DATE_INVALID` | Soccer research date is not a real UTC calendar date in YYYY-MM-DD form. | Correct the date. | Use a valid calendar date. |
| `PS_CLOB_AUTH_FAILED` | CLOB L2 credentials could not be derived or created. | Verify ClobAuth and CLOB access. | Polymarket trading authentication failed. |
| `PS_CLOB_AUTH_INVALID` | CLOB returned an invalid credential response. | Stop and check provider status. | Polymarket returned invalid authentication data. |
| `PS_GEOBLOCKED` | Official Polymarket geoblock response reports `blocked: true`. | Do not bypass the restriction or submit. | Polymarket reports this request as blocked. |
| `PS_CLOB_REJECTED` | CLOB explicitly rejected the submitted order. | Read order/trade state before deciding on any new user-approved order. | Polymarket rejected this FAK order. |
| `PS_SUBMISSION_UNKNOWN` | POST timed out or returned an ambiguous response and one read-only reconciliation did not confirm an order record. | Never resubmit automatically. Reconcile in Polymarket before any new approval. | Order status is unknown; do not submit it again until reconciled. |
| `PS_ORDER_STATUS_UNKNOWN` | CLOB order read-back did not confirm a status. | Query status again; do not treat acceptance as a fill. | Order fill status is not confirmed. |
| `PS_CANCEL_UNKNOWN` | Cancel result and one order read-back were inconclusive. | Inspect the order before another cancellation request. | Cancellation status is unknown. |
| `PS_PORTFOLIO_INVALID` | Public positions response did not match the v2 shape or cursor metadata. | Retry the read after checking the Data API response. | This positions page could not be decoded. |
| `PS_PREFLIGHT_FAILED` | A provider or credential failure stopped execution before the order POST. | Resolve the reported provider or authentication issue first. | Trading preflight could not complete; no order was sent. |

## Preparation and execution

`prepare_order_signing` returns `status: "PREPARED"` with the Polymarket Order payload, one `requestWalletSignIntent`, `submitsOrder: false`, and `preparationFreshness: { bookAgeMs }`. The age value is informational; there is no 120-second preparation cutoff. `get_quote` continues to label books older than 30 seconds as `STALE`, but that label does not block preparation or submission. Invalid or future timestamps remain malformed provider data.

PayBox handles human approval and wallet signing through `request_wallet_sign` and `get_request`. The Polymarket Order signature signs the exact market token, side, price-derived amounts, size, wallet, exchange domain, and FAK request. ClobAuth is a separate Polymarket L1 operation used to derive L2 credentials; it is not a PolyScope execution approval. No custom ExecutionApproval payload, signature, or deadline is used.

BUY maker/taker amounts encode the exact selected price and share size. Current fee metadata is checked against the all-in cap before one order POST. The adapter does not call the SDK's `maxSpend` order resizer because that API changes the signed BUY amount, which would conflict with the selected share size; if the exact signed size exceeds the cap, preparation or submission rejects it instead of resizing silently. Polymarket remains responsible for account balance, allowance, and other exchange constraints.

The adapter has per-request network timeouts and no custom total execution budget. A POST that may have reached CLOB is never retried automatically; the adapter makes at most one read-only order-hash reconciliation. An unresolved result is returned as `UNKNOWN`.

Soccer provider failures return `availability: "UNAVAILABLE"` with a provider reason and source timestamps. HTTP errors retain safe status-specific reasons. Response bodies and credentials are never included. PolyScope does not substitute incomplete form history or convert provider failure into coverage.
