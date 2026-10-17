# PolyScope error codes

Known order-preparation failures return `status: "REJECTED"`, `errorCode`, `reason`, `submitsOrder: false`, and book-age metadata, without an order or signing intent. Unexpected programming failures remain MCP errors. `UNAVAILABLE` provider output is a data status, not successful coverage.

| Code | Cause | Retry behavior | User-facing explanation |
|---|---|---|---|
| `PS_PROVIDER_UNAVAILABLE` | Polymarket read failed or returned a non-success HTTP status. | Retry a read after checking host access; reconcile an ambiguous order before any new submission. | Polymarket data could not be read. |
| `PS_PROVIDER_TIMEOUT` | Polymarket read exceeded its per-request timeout. | Reads may be retried; a timed-out order POST is `UNKNOWN` and must be reconciled. | Polymarket data did not respond in time. |
| `PS_PROVIDER_INVALID` | Invalid JSON, market/book shape, or numeric market data required to construct the request. | Check provider status; do not prepare from malformed market data. | Polymarket returned incomplete or unreadable data. |
| `PS_RESPONSE_TOO_LARGE` | A Polymarket response exceeded 1 MiB. | Reduce the requested result size where possible. | The provider response was too large to process. |
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
| `PS_ORDER_TYPE_MISMATCH` | The requested submission type does not match the prepared FAK/FOK type. | Use `submit_order` with the exact prepared type; no POST was made. | Submission type differs from the prepared order. |
| `PS_SIGNATURE_INVALID` | Polymarket Order signature does not recover to the selected signer. | Select the matching PayBox wallet and sign the exact order payload again. | The order signature does not match the selected wallet. |
| `PS_WALLET_BINDING` | Signer, maker, signature type, or order signer does not match the wallet type. | Select the matching existing PayBox wallet and prepare again. | The selected wallet does not match this order. |
| `PS_AUTH_SIGNATURE_INVALID` | ClobAuth signature cannot be recovered. | Prepare and sign a fresh ClobAuth payload. | Polymarket authentication signature is invalid. |
| `PS_AUTH_NONCE_INVALID` | ClobAuth nonce exceeds the public SDK safe-integer range. | Use a nonnegative nonce no larger than Number.MAX_SAFE_INTEGER. | Authentication nonce is invalid. |
| `PS_AUTH_WALLET_MISMATCH` | ClobAuth signer differs from the selected owner EOA. | Prepare and sign a new ClobAuth for the selected owner EOA. | Authentication and order use different owner signers. |
| `PS_DATE_INVALID` | Soccer research date is not a real UTC calendar date in YYYY-MM-DD form. | Correct the date. | Use a valid calendar date. |
| `PS_CLOB_AUTH_FAILED` | CLOB L2 credentials could not be derived or created. | Verify ClobAuth and CLOB access. | Polymarket trading authentication failed. |
| `PS_CLOB_AUTH_REJECTED` | The CLOB rejected an L1 ClobAuth request with HTTP 401. | Prepare and sign a new ClobAuth, then retry explicitly. PolyScope does not sign or replay it. | Polymarket rejected ClobAuth; sign a fresh payload. |
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
| `PS_PREFLIGHT_FAILED` | A provider or credential failure stopped execution before the order POST. | Resolve the reported provider or authentication issue first. | Trading preflight could not complete; no order was sent. |


Authentication and order errors are normalized from SDK classes/provider HTTP status; raw provider bodies, credentials, secrets and passphrases are omitted. HTTP status is retained when observed. `PS_CLOB_AUTH_REJECTED` means explicit fresh ClobAuth is required; another order alone does not require reauthentication.

The normal flow is authentication once, then prepare → PayBox Order signing → submit for each exact FAK/FOK order. Diagnostic validators are optional. Preparation takes reusable `clobAuth` because the public SDK requires a secure client. SDK-generated amounts must match the exact requested shares and bound; an SDK rounding change or a fee-inclusive cap overrun rejects instead of resizing.

`PS_MUTATION_RETRY_BLOCKED` is an internal transport sentinel: the first financial request may have reached the provider. It is normalized to `PS_SUBMISSION_UNKNOWN` or `PS_CANCEL_UNKNOWN` after read-only reconciliation. Neither POST nor DELETE is transmitted twice automatically. `UNKNOWN` never authorizes another trade.

Readiness uses indexed SDK approval state. Funding, gas, order sufficiency and fresh approval finality remain UNKNOWN where unavailable. Redemption uses indexed positions and SDK unsigned calls; it never approves or broadcasts, and always requires an external action until Polygon PayBox proposal validation is established.
