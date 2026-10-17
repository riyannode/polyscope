import { createHash } from "node:crypto";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { checkEnvironment, ConformanceError, release, reportConformance } from "./report.mjs";
import { withProcess } from "./process.mjs";
import { compileSchema, validateSample } from "./schema.mjs";

export { ConformanceError, reportConformance };
const PROTOCOL_VERSION = release.protocolVersion;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_TOOLS = 256;
const MAX_TOOL_SCHEMA_BYTES = 64 * 1024;
const MAX_CONTENT_ITEMS = 128;
const MAX_TOOL_NAME_BYTES = 128;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_CURSOR_BYTES = 1024;
const OPERATION_TIMEOUT_MS = 10_000;

export async function testArtifact(root = process.cwd()) {
  const artifact = resolve(root, "dist/plugin.mjs");
  checkEnvironment();
  const bytes = await validateArtifact(artifact);
  let config;
  try {
    config = JSON.parse(await readFile(resolve(root, "paybox-plugin.json"), "utf8"));
  } catch {
    fail("Read a valid paybox-plugin.json with tool and arguments", "config_invalid");
  }
  object(config, "sample configuration", "config_invalid");
  if (typeof config.tool !== "string" || config.tool.length === 0) fail("Set the sample tool name", "config_invalid");
  object(config.arguments, "sample arguments", "config_invalid");
  if (Buffer.byteLength(config.tool) > MAX_TOOL_NAME_BYTES) fail(`sample tool name exceeds ${MAX_TOOL_NAME_BYTES} bytes`, "limit_exceeded");
  if (Buffer.byteLength(JSON.stringify(config.arguments)) > MAX_ARGUMENT_BYTES) fail(`sample arguments exceed ${MAX_ARGUMENT_BYTES} bytes`, "limit_exceeded");
  const tools = await listTools(artifact);
  const selected = tools.find((tool) => tool.name === config.tool);
  if (!selected) fail("sample tool was not returned by tools/list", "config_invalid");
  validateSample(selected, config.arguments);
  const response = await runOperation(artifact, {
    method: "tools/call",
    params: { name: config.tool, arguments: config.arguments },
  });
  validateCallResult(response.result);
  if (response.result.isError === true) fail("sample tools/call returned isError: true", "tool_failed");
  validateSample(selected, config.arguments, response.result);
  const checks = [{ tool: config.tool, status: "passed" }];
  const researchTools = [
    ["get_soccer_news", { teams: ["Arsenal"], limit: 3 }],
    ...["PL", "PD", "SA", "CL"].map((league) => ["research_soccer", { league, days: 0, limit: 3 }]),
  ];
  for (const [toolName, argumentsValue] of researchTools) {
    const tool = tools.find((entry) => entry.name === toolName);
    if (!tool) fail(`${toolName} was not returned by tools/list`, "tool_catalog_invalid");
    const result = await callTool(artifact, tool, argumentsValue);
    checks.push({ tool: toolName, status: "passed", availability: result.structuredContent.availability, reason: result.structuredContent.reason });
  }
  const market = response.result.structuredContent?.markets?.find((entry) => entry.outcomes?.length > 0 && entry.acceptingOrders === true);
  const outcome = market?.outcomes?.[0];
  if (!market || !outcome) fail("sample search did not return an accepting market outcome for quote conformance", "tool_failed");
  const quoteTool = tools.find((entry) => entry.name === "get_quote");
  if (!quoteTool) fail("get_quote was not returned by tools/list", "tool_catalog_invalid");
  const quoteResult = await callTool(artifact, quoteTool, { marketId: market.marketId, assetId: outcome.assetId, side: "BUY", size: "1", depth: 5 });
  checks.push({ tool: "get_quote", status: "passed", availability: quoteResult.structuredContent.availability, freshness: quoteResult.structuredContent.freshness, bookTimestamp: quoteResult.structuredContent.bookTimestamp, bookAgeMs: quoteResult.structuredContent.bookAgeMs });
  const prepareTool = tools.find((entry) => entry.name === "prepare_order_signing");
  if (!prepareTool) fail("prepare_order_signing was not returned by tools/list", "tool_catalog_invalid");
  const bookAgeMs = quoteResult.structuredContent.bookAgeMs;
  if (!Number.isSafeInteger(bookAgeMs) || bookAgeMs < 0) {
    checks.push({ tool: "prepare_order_signing", status: "skipped", reason: "live CLOB book age is unavailable or invalid; deterministic payload preparation is covered by pnpm test" });
  } else {
    const minimumShareMicros = toMicros(quoteResult.structuredContent.minOrderSize);
    const hundredthShares = (minimumShareMicros + 9_999n) / 10_000n;
    const signingSize = formatHundredths(hundredthShares);
    const prepareArguments = {
      marketId: market.marketId,
      assetId: outcome.assetId,
      makerAddress: "0x0000000000000000000000000000000000000001",
      signingAddress: "0x0000000000000000000000000000000000000001",
      walletType: "EOA",
      side: "BUY",
      priceLimit: formatMicros(1_000_000n - toMicros(quoteResult.structuredContent.tickSize)),
      size: signingSize,
      maxNominalPusd: "999999999999999999999999999",
    };
    const preparedResponse = await runOperation(artifact, {
      method: "tools/call", params: { name: prepareTool.name, arguments: prepareArguments },
    });
    validateCallResult(preparedResponse.result);
    if (preparedResponse.result.isError === true) fail("prepare_order_signing returned an unexpected MCP error", "tool_failed");
    validateSample(prepareTool, prepareArguments, preparedResponse.result);
    const prepared = preparedResponse.result.structuredContent;
    if (prepared.status === "REJECTED") fail(`preparation rejected: ${prepared.errorCode}`, "tool_failed");
    else {
      if (prepared.submitsOrder !== false || prepared.preparedOrder?.market?.outcome !== outcome.name) {
        fail("prepared payload did not preserve the selected outcome or no-submit boundary", "result_invalid");
      }
      checks.push({ tool: "prepare_order_signing", status: "passed", submitsOrder: false });
    }
  }
  return {
    status: "passed",
    sampleCall: checks[0],
    targetedCalls: checks.slice(1),
    artifact: { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    discoveredToolCount: tools.length,
  };
}

async function callTool(artifact, tool, argumentsValue, options = {}) {
  const response = await runOperation(artifact, {
    method: "tools/call",
    params: { name: tool.name, arguments: argumentsValue },
  }, options);
  validateCallResult(response.result);
  if (response.result.isError === true) fail(`${tool.name} tools/call returned isError: true`, "tool_failed");
  validateSample(tool, argumentsValue, response.result);
  return response.result;
}

export async function testOfflineArtifact(root = process.cwd()) {
  const artifact = resolve(root, "dist/plugin.mjs");
  const tools = await listTools(artifact);
  const prepareTool = tools.find((tool) => tool.name === "prepare_order_signing");
  if (!prepareTool) fail("prepare_order_signing was not returned by tools/list", "tool_catalog_invalid");
  const searchTool = tools.find((tool) => tool.name === "search_markets");
  const search = await callTool(artifact, searchTool, { query: "Sample market", limit: 3 }, { fixtures: true });
  if (search.structuredContent.markets.length !== 1 || "marketRestricted" in search.structuredContent.markets[0]) {
    fail("market search exposed Gamma restricted metadata", "market_output_invalid");
  }
  const submitTool = tools.find((tool) => tool.name === "submit_fak_order");
  if (!submitTool) fail("submit_fak_order was not returned by tools/list", "tool_catalog_invalid");
  if ("executionApprovalSignature" in submitTool.inputSchema.properties) {
    fail("submit schema still requires a PolyScope execution approval signature", "schema_invalid");
  }
  const base = {
    marketId: "1", assetId: "123",
    makerAddress: "0x0000000000000000000000000000000000000001",
    signingAddress: "0x0000000000000000000000000000000000000001",
    walletType: "EOA", size: "10", maxNominalPusd: "5.13",
  };
  const buy = await callTool(artifact, prepareTool, { ...base, side: "BUY", priceLimit: "0.50" }, { fixtures: true });
  const buyOrder = buy.structuredContent.preparedOrder.order;
  if ("marketRestricted" in buy.structuredContent.preparedOrder.market
    || "executionApprovalSigningIntent" in buy.structuredContent
    || "accountGeoblockChecked" in buy.structuredContent) {
    fail("prepared order exposed removed eligibility or execution-approval metadata", "market_output_invalid");
  }
  if (buyOrder.orderType !== "FAK" || buyOrder.maxFeePusd !== "0.125" || buyOrder.maxNominalPusd !== "5.13"
    || buyOrder.price !== "0.50" || buyOrder.size !== "10" || buyOrder.makerAmount !== "5000000" || buyOrder.takerAmount !== "10000000") {
    fail("BUY order did not preserve the exact user price, size, FAK type, and fee-inclusive cap", "order_policy_invalid");
  }
  const restrictedPreparation = await callTool(artifact, prepareTool, { ...base, side: "BUY", priceLimit: "0.50" }, {
    fixtures: true, fixtureScenario: "restricted-prepare",
  });
  if (restrictedPreparation.structuredContent.status !== "PREPARED") {
    fail("Gamma restricted metadata alone blocked order preparation", "market_eligibility_invalid");
  }
  if (buy.structuredContent.preparationFreshness.staleAfterMs !== undefined) {
    fail("prepared-order response retained an arbitrary age threshold", "order_hash_invalid");
  }
  const replaySigner = privateKeyToAccount(generatePrivateKey());
  const replayOrder = await callTool(artifact, prepareTool, {
    ...base, makerAddress: replaySigner.address, signingAddress: replaySigner.address,
    side: "BUY", priceLimit: "0.50",
  }, { fixtures: true });
  const replayPrepared = replayOrder.structuredContent.preparedOrder;
  const orderSignature = await replaySigner.signTypedData(replayPrepared.typedData);
  const validateOrderTool = tools.find((tool) => tool.name === "validate_order_signature");
  const validOrderSignature = await callTool(artifact, validateOrderTool, {
    preparedOrder: replayPrepared, signature: orderSignature,
  }, { fixtures: true });
  if (validOrderSignature.structuredContent.valid !== true) {
    fail("metadata-free prepared order did not validate its unchanged Polymarket EIP-712 signature", "signature_validation_invalid");
  }
  const metadataOnlyChange = await callTool(artifact, validateOrderTool, {
    preparedOrder: { ...replayPrepared, market: { ...replayPrepared.market, bookTimestamp: "1" } }, signature: orderSignature,
  }, { fixtures: true });
  if (metadataOnlyChange.structuredContent.valid !== true) {
    fail("changing unsigned book-age metadata changed Polymarket EIP-712 signature validation", "order_hash_invalid");
  }
  const clobAuthTool = tools.find((tool) => tool.name === "prepare_clob_auth");
  const clobAuthResult = await callTool(artifact, clobAuthTool, { signerAddress: replaySigner.address, nonce: "0" }, { fixtures: true });
  const clobAuth = {
    timestamp: clobAuthResult.structuredContent.timestamp,
    nonce: clobAuthResult.structuredContent.nonce,
    signature: await replaySigner.signTypedData(clobAuthResult.structuredContent.typedData),
  };
  const submitArgs = { preparedOrder: replayPrepared, orderSignature, clobAuth };
  const successfulSubmit = await callTool(artifact, submitTool, submitArgs, { fixtures: true, fixtureScenario: "submit-valid" });
  if (successfulSubmit.structuredContent.status !== "SUBMITTED" || !successfulSubmit.structuredContent.orderId) {
    fail("a valid signed FAK order without ExecutionApproval did not reach one intercepted CLOB POST", "submit_invalid");
  }
  for (const [scenario, age] of [["restricted-submit", 0], ["submit-stale-book", 51_000]]) {
    const result = await callTool(artifact, submitTool, submitArgs, { fixtures: true, fixtureScenario: scenario });
    if (result.structuredContent.status !== "SUBMITTED") {
      fail(`${scenario} alone incorrectly blocked a signed limit-bounded FAK order`, "submit_preflight_invalid");
    }
    if (age > 0 && result.structuredContent.errorCode !== null) fail("stale informational book age created an execution error", "submit_preflight_invalid");
  }
  const invalidOrderSignature = await callTool(artifact, submitTool, {
    ...submitArgs, orderSignature: `0x${"0".repeat(130)}`,
  }, { fixtures: true });
  if (invalidOrderSignature.structuredContent.errorCode !== "PS_SIGNATURE_INVALID") {
    fail("invalid Polymarket order signature was accepted", "signature_validation_invalid");
  }
  const geoblocked = await callTool(artifact, submitTool, submitArgs, { fixtures: true, fixtureScenario: "geoblocked" });
  if (geoblocked.structuredContent.errorCode !== "PS_GEOBLOCKED") fail("official blocked geoblock response did not prevent submission", "geoblock_invalid");
  const missingCredentials = await callTool(artifact, submitTool, submitArgs, { fixtures: true, fixtureScenario: "missing-credentials" });
  if (missingCredentials.structuredContent.errorCode !== "PS_CLOB_AUTH_FAILED") fail("missing CLOB credentials were not reported", "clob_auth_invalid");
  const changedFee = await callTool(artifact, submitTool, submitArgs, { fixtures: true, fixtureScenario: "fee-changed" });
  if (changedFee.structuredContent.errorCode !== "PS_SPENDING_CAP") {
    fail("current fee increase was not bounded by the user-approved all-in spending cap", "spending_cap_invalid");
  }
  const ambiguous = await callTool(artifact, submitTool, submitArgs, { fixtures: true, fixtureScenario: "submit-ambiguous" });
  if (ambiguous.structuredContent.status !== "UNKNOWN" || ambiguous.structuredContent.errorCode !== "PS_SUBMISSION_UNKNOWN") {
    fail("ambiguous order POST was retried or presented as a confirmed result", "ambiguous_submit_invalid");
  }
  const sell = await callTool(artifact, prepareTool, { ...base, side: "SELL", priceLimit: "0.49" }, { fixtures: true });
  const sellOrder = sell.structuredContent.preparedOrder.order;
  if (sellOrder.side !== "SELL" || sellOrder.orderType !== "FAK" || sellOrder.price !== "0.49"
    || sellOrder.size !== "10" || sellOrder.makerAmount !== "10000000" || sellOrder.takerAmount !== "4900000") {
    fail("SELL order did not preserve the exact user minimum price, size, and FAK type", "order_policy_invalid");
  }
  const deposit = await callTool(artifact, prepareTool, {
    ...base, makerAddress: "0x0000000000000000000000000000000000000002",
    walletType: "DEPOSIT_WALLET", side: "BUY", priceLimit: "0.50",
  }, { fixtures: true });
  const depositTypedData = deposit.structuredContent.preparedOrder.typedData;
  if (depositTypedData.primaryType !== "TypedDataSign"
    || depositTypedData.message.verifyingContract !== "0x0000000000000000000000000000000000000002"
    || depositTypedData.message.contents.signatureType !== 3
    || deposit.structuredContent.preparedOrder.wallet.orderSignerAddress !== "0x0000000000000000000000000000000000000002") {
    fail("Deposit Wallet order payload did not use the documented ERC-7739 TypedDataSign shape", "deposit_wallet_payload_invalid");
  }
  const stalePrepare = await callTool(artifact, prepareTool, { ...base, side: "BUY", priceLimit: "0.50" }, {
    fixtures: true, fixtureScenario: "book-121000",
  });
  if (stalePrepare.structuredContent.status !== "PREPARED" || stalePrepare.structuredContent.preparationFreshness.bookAgeMs !== 121_000) {
    fail("book age beyond 120 seconds blocked preparation", "preparation_freshness_invalid");
  }
  const unsafeSaltOrder = await runOperation(artifact, {
    method: "tools/call",
    params: { name: submitTool.name, arguments: {
      preparedOrder: { ...buy.structuredContent.preparedOrder, order: { ...buyOrder, salt: "9007199254740992" } },
      orderSignature: `0x${"0".repeat(130)}`,
      clobAuth: { timestamp: String(Math.floor(Date.now() / 1000)), nonce: "0", signature: `0x${"0".repeat(130)}` },
    } },
  }, { fixtures: true });
  if (unsafeSaltOrder.result?.isError !== true) fail("submit accepted an order salt that cannot be serialized exactly", "order_serialization_invalid");
  for (const [scenario, errorCode] of [
    ["wrong-market", "PS_MARKET_IDENTITY"], ["wrong-book", "PS_MARKET_IDENTITY"],
    ["provider-invalid", "PS_PROVIDER_INVALID"], ["provider-invalid-json", "PS_PROVIDER_INVALID"],
    ["invalid-level", "PS_PROVIDER_INVALID"], ["invalid-timestamp", "PS_PROVIDER_INVALID"],
    ["future-timestamp", "PS_PROVIDER_INVALID"], ["provider-unavailable", "PS_PROVIDER_UNAVAILABLE"],
  ]) {
    const result = await callTool(artifact, prepareTool, { ...base, side: "BUY", priceLimit: "0.50" }, { fixtures: true, fixtureScenario: scenario });
    if (result.structuredContent.status !== "REJECTED" || result.structuredContent.errorCode !== errorCode
      || !result.structuredContent.reason || "preparedOrder" in result.structuredContent) {
      fail("known preparation failure did not return a distinguishable structured rejection", "preparation_rejection_invalid");
    }
  }
  const unexpected = await runOperation(artifact, {
    method: "tools/call", params: { name: prepareTool.name, arguments: { ...base, side: "BUY", priceLimit: "0.50" } },
  }, { fixtures: true, fixtureScenario: "unexpected-failure" });
  if (unexpected.result?.isError !== true || unexpected.result.structuredContent !== undefined
    || !unexpected.result.content.some((item) => item.text?.includes("fixture unexpected programming failure"))) {
    fail("unexpected programming failure was converted into a known preparation rejection", "unexpected_failure_hidden");
  }
  const quoteTool = tools.find((tool) => tool.name === "get_quote");
  const quote = await callTool(artifact, quoteTool, { marketId: "1", assetId: "123", side: "BUY", size: "10" }, { fixtures: true });
  if ("marketRestricted" in quote.structuredContent || "accountGeoblockChecked" in quote.structuredContent) {
    fail("quote exposed removed market or account eligibility metadata", "quote_output_invalid");
  }
  if (quote.structuredContent.feeRate !== "0.05" || quote.structuredContent.feeExponent !== 1 || quote.structuredContent.estimatedFeePusd !== "0.125") {
    fail("quote did not use the official per-market fee descriptor and exact fee calculation", "fee_calculation_invalid");
  }
  const staleQuote = await callTool(artifact, quoteTool, { marketId: "1", assetId: "123", side: "BUY", size: "10" }, { fixtures: true, fixtureScenario: "book-51000" });
  if (staleQuote.structuredContent.freshness !== "STALE" || staleQuote.structuredContent.bookAgeMs !== 51_000
    || staleQuote.structuredContent.staleAfterSeconds !== 30) fail("quote freshness label stopped being informational", "quote_freshness_invalid");
  const overCap = await runOperation(artifact, {
    method: "tools/call",
    params: { name: prepareTool.name, arguments: { ...base, side: "BUY", priceLimit: "0.50", maxNominalPusd: "5.12" } },
  }, { fixtures: true });
  validateSample(prepareTool, { ...base, side: "BUY", priceLimit: "0.50", maxNominalPusd: "5.12" }, overCap.result);
  if (overCap.result.structuredContent.status !== "REJECTED" || overCap.result.structuredContent.errorCode !== "PS_SPENDING_CAP") fail("BUY preparation accepted a fee-inclusive amount above the user cap", "order_policy_invalid");
  const wrongAsset = await runOperation(artifact, {
    method: "tools/call",
    params: { name: prepareTool.name, arguments: { ...base, assetId: "999", side: "BUY", priceLimit: "0.50" } },
  }, { fixtures: true });
  validateSample(prepareTool, { ...base, assetId: "999", side: "BUY", priceLimit: "0.50" }, wrongAsset.result);
  if (wrongAsset.result.structuredContent.status !== "REJECTED" || wrongAsset.result.structuredContent.errorCode !== "PS_MARKET_IDENTITY") fail("order preparation accepted an asset not mapped to the market outcome", "market_identity_invalid");
  const newsTool = tools.find((tool) => tool.name === "get_soccer_news");
  const news = await callTool(artifact, newsTool, { teams: ["Arsenal"], limit: 5 }, { fixtures: true });
  if (news.structuredContent.items.length !== 1 || news.structuredContent.items[0].matchedTeams[0] !== "Arsenal") {
    fail("soccer news included a headline unrelated to the requested team", "news_attribution_invalid");
  }
  const researchTool = tools.find((tool) => tool.name === "research_soccer");
  for (const league of ["PL", "PD", "SA", "CL"]) {
    const research = await callTool(artifact, researchTool, { league, date: "2026-10-17", days: 0, limit: 3 }, { fixtures: true });
    if (research.structuredContent.availability !== "AVAILABLE" || research.structuredContent.fixtures[0]?.leagueProviderId !== league) {
      fail(`${league} soccer fixture was not mapped from football-data.org data`, "soccer_mapping_invalid");
    }
  }
  const exactFixtureIds = { PL: "1001", PD: "2001", SA: "3001", CL: "4001" };
  for (const [league, fixtureId] of Object.entries(exactFixtureIds)) {
    const exactForm = await callTool(artifact, researchTool, { league, fixtureId, date: "2026-10-17", days: 0, limit: 3 }, { fixtures: true });
    const fixture = exactForm.structuredContent.fixtures[0];
    const teamFormSources = exactForm.structuredContent.sources.filter((source) => source.purpose === "TEAM_FORM");
    if (fixture?.formCoverage !== "COMPLETE_LAST_5" || fixture.homeRecentResults.length !== 5 || fixture.awayRecentResults.length !== 5) {
      fail(`${league} form was not reported as complete with exactly five results per team`, "soccer_form_invalid");
    }
    if (teamFormSources.length !== 2 || teamFormSources.some((source) => {
      const url = new URL(source.url);
      return url.searchParams.get("competitions") !== ({ PL: "2021", PD: "2014", SA: "2019", CL: "2001" })[league]
        || url.searchParams.get("status") !== "FINISHED" || url.searchParams.has("dateTo")
        || url.searchParams.get("limit") !== "100";
    })) {
      fail(`${league} team-form requests did not use a numeric competition ID without the failing date filter`, "soccer_team_filter_invalid");
    }
  }
  const mixedCompetitionForm = await callTool(artifact, researchTool, { league: "PL", fixtureId: "560611", date: "2026-10-17", days: 0, limit: 3 }, { fixtures: true });
  const mixedFixture = mixedCompetitionForm.structuredContent.fixtures[0];
  const brentfordSource = mixedCompetitionForm.structuredContent.sources.find((source) => source.purpose === "TEAM_FORM" && source.teamProviderId === "402");
  const liverpoolSource = mixedCompetitionForm.structuredContent.sources.find((source) => source.purpose === "TEAM_FORM" && source.teamProviderId === "64");
  if (mixedFixture?.formCoverage !== "UNAVAILABLE" || brentfordSource?.teamName !== "Brentford FC"
    || brentfordSource.availability !== "AVAILABLE" || brentfordSource.returnedResultCount !== 5
    || liverpoolSource?.teamName !== "Liverpool FC" || liverpoolSource.availability !== "UNAVAILABLE"
    || !liverpoolSource.reason?.includes("HTTP 403")) {
    fail("Brentford and Liverpool team-form results were not reported independently", "soccer_team_form_binding_invalid");
  }
  const brentfordRecent = brentfordSource && mixedFixture?.homeRecentResults;
  if (!brentfordRecent || brentfordRecent.length !== 5 || brentfordRecent[0]?.date !== "2026-10-17"
    || brentfordRecent.some((result) => result.fixtureId === "91002" || result.fixtureId === "560611" || result.fixtureId === "91007")) {
    fail("team form did not filter mixed competitions, non-finished matches, and kickoff times", "soccer_team_history_filter_invalid");
  }
  const incompleteForm = await callTool(artifact, researchTool, { league: "PL", fixtureId: "9999", date: "2026-10-20", days: 0, limit: 3 }, { fixtures: true });
  if (incompleteForm.structuredContent.fixtures[0]?.formCoverage !== "UNAVAILABLE"
    || incompleteForm.structuredContent.fixtures[0]?.homeFormCoverage !== "UNAVAILABLE"
    || incompleteForm.structuredContent.fixtures[0]?.homeRecentResults.length !== 4) {
    fail("incomplete historical soccer form was silently presented as complete", "soccer_form_invalid");
  }
  const deniedForm = await callTool(artifact, researchTool, { league: "PL", fixtureId: "8888", date: "2026-10-21", days: 0, limit: 3 }, { fixtures: true });
  const deniedReason = deniedForm.structuredContent.sources.find((source) => source.purpose === "TEAM_FORM" && source.teamProviderId === "888")?.reason ?? "";
  if (!deniedReason.includes("HTTP 403") || !deniedReason.toLowerCase().includes("permission") || deniedReason.includes("sensitive provider detail")) {
    fail("team-form permission failures did not expose a safe HTTP status", "soccer_provider_error_invalid");
  }
  const rateLimitedForm = await callTool(artifact, researchTool, { league: "SA", fixtureId: "8889", date: "2026-10-22", days: 0, limit: 3 }, { fixtures: true });
  const rateLimitReason = rateLimitedForm.structuredContent.sources.find((source) => source.purpose === "TEAM_FORM" && source.teamProviderId === "889")?.reason ?? "";
  if (!rateLimitReason.includes("HTTP 429")) {
    fail("team-form rate-limit failures did not expose the HTTP status", "soccer_provider_error_invalid");
  }
  const unavailable = await callTool(artifact, researchTool, { league: "PL", date: "2026-11-01", days: 0, limit: 3 }, { fixtures: true });
  if (unavailable.structuredContent.availability !== "UNAVAILABLE") fail("provider failure was presented as available soccer data", "provider_failure_hidden");
  const portfolioTool = tools.find((tool) => tool.name === "get_portfolio");
  const portfolio = await callTool(artifact, portfolioTool, { walletAddress: "0x0000000000000000000000000000000000000001", limit: 10 }, { fixtures: true });
  if (portfolio.structuredContent.addressBinding !== "PUBLIC_ADDRESS_UNVERIFIED"
    || portfolio.structuredContent.positions.length !== 1 || portfolio.structuredContent.complete !== false
    || portfolio.structuredContent.hasMore !== true || portfolio.structuredContent.nextCursor !== "fixture-next-page") {
    fail("portfolio did not preserve the representative partial v2 page and unverified address label", "portfolio_pagination_invalid");
  }
  const portfolioNextPage = await callTool(artifact, portfolioTool, {
    walletAddress: "0x0000000000000000000000000000000000000001", limit: 10, cursor: portfolio.structuredContent.nextCursor,
  }, { fixtures: true });
  if (portfolioNextPage.structuredContent.positions.length !== 1 || portfolioNextPage.structuredContent.complete !== true
    || portfolioNextPage.structuredContent.hasMore !== false || portfolioNextPage.structuredContent.nextCursor !== null) {
    fail("portfolio did not mark the final v2 cursor page complete", "portfolio_pagination_invalid");
  }
  const toolNames = new Set(tools.map((tool) => tool.name));
  for (const name of ["submit_fak_order", "get_order_status", "cancel_order", "get_portfolio"]) {
    if (!toolNames.has(name)) fail(`${name} was not registered`, "tool_catalog_invalid");
  }
  return {
    status: "passed",
    deterministicCases: [
      "BUY FAK preserves exact signed limit, size, precision, and fee-inclusive cap", "no ExecutionApproval signature is required", "signed order is accepted for exactly one intercepted CLOB POST", "SELL FAK preserves exact signed minimum price and size", "market fee descriptor and exact fee calculation",
      "reject invalid Polymarket order signature", "reject real provider geoblock", "missing CLOB credentials handled", "Deposit Wallet TypedDataSign preparation",
      "121s book age is informational for preparation", "restricted Gamma metadata omitted and does not reject preparation/submission", "market and quote responses omit removed eligibility metadata", "unsigned book metadata does not change EIP-712 signature validation", "51s quote remains labeled stale", "51s book age alone does not block bounded FAK execution", "ambiguous submission is reconciled once and never reposted", "provider-invalid structured diagnostics", "reject unsafe CLOB salt precision", "reject fee-inclusive cap overrun", "reject wrong outcome asset",
      "team-attributed news", "PL/PD/SA/CL fixture mapping", "documented team-form filters with mixed-competition history filtering", "independent Brentford/Liverpool form status",
      "safe team-form HTTP 403 permission and 429 rate-limit diagnostics", "complete and unavailable form handling", "provider failure remains unavailable", "official v2 portfolio rows and cursor pagination completeness", "public portfolio address is not wallet proof", "trade tools registered without submission",
    ],
  };
}

function toMicros(value) {
  const [whole, fraction = ""] = value.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > 6) {
    fail("provider minimum size is not a supported decimal", "tool_failed");
  }
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function formatHundredths(value) {
  const whole = value / 100n;
  const fraction = (value % 100n).toString().padStart(2, "0");
  return fraction === "00" ? String(whole) : `${whole}.${fraction}`;
}

function formatMicros(value) {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction.length === 0 ? String(whole) : `${whole}.${fraction}`;
}

async function validateArtifact(artifact) {
  if (basename(artifact) !== "plugin.mjs") fail("artifact must be named plugin.mjs", "artifact_invalid");
  let bytes;
  try {
    bytes = await readFile(artifact);
  } catch {
    fail("Build dist/plugin.mjs before running conformance", "artifact_invalid");
  }
  if (bytes.length === 0 || bytes.length > MAX_ARTIFACT_BYTES) {
    fail(`plugin.mjs must be between 1 and ${MAX_ARTIFACT_BYTES} bytes`, "artifact_invalid");
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) fail("plugin.mjs must be valid UTF-8", "artifact_invalid");
  return bytes;
}

async function listTools(artifact) {
  const tools = [];
  const names = new Set();
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < 16; page += 1) {
    const response = await runOperation(artifact, {
      method: "tools/list",
      params: cursor === undefined ? {} : { cursor },
    });
    const result = object(response.result, "tools/list result", "tool_catalog_invalid");
    if (!Array.isArray(result.tools)) fail("tools/list result must contain a tools array", "tool_catalog_invalid");
    if (tools.length + result.tools.length > MAX_TOOLS) fail(`tools/list returned more than ${MAX_TOOLS} tools`, "limit_exceeded");
    for (const value of result.tools) {
      const tool = object(value, "tool definition", "tool_catalog_invalid");
      if (typeof tool.name !== "string" || tool.name.length === 0 || names.has(tool.name)) {
        fail("tool names must be non-empty and unique", "tool_catalog_invalid");
      }
      if (Buffer.byteLength(tool.name) > MAX_TOOL_NAME_BYTES) fail(`tool name exceeds ${MAX_TOOL_NAME_BYTES} bytes`, "limit_exceeded");
      for (const field of ["title", "description"]) {
        if (tool[field] != null && typeof tool[field] !== "string") fail(`tool ${field} must be a string`, "tool_catalog_invalid");
      }
      if (tool.annotations != null) object(tool.annotations, "tool annotations", "tool_catalog_invalid");
      names.add(tool.name);
      const inputSchema = object(tool.inputSchema, "tool input schema", "tool_catalog_invalid");
      if (containsKey(inputSchema, "x-mcp-header")) fail("tool uses unsupported x-mcp-header", "tool_catalog_invalid");
      const schemaBytes = Buffer.byteLength(JSON.stringify(inputSchema)) +
        (tool.outputSchema === undefined ? 0 : Buffer.byteLength(JSON.stringify(tool.outputSchema)));
      if (schemaBytes > MAX_TOOL_SCHEMA_BYTES) fail(`tool schemas exceed ${MAX_TOOL_SCHEMA_BYTES} bytes`, "limit_exceeded");
      compileSchema(inputSchema);
      if (tool.outputSchema !== undefined) compileSchema(tool.outputSchema);
      tools.push(tool);
    }
    if (result.nextCursor == null) return tools;
    if (typeof result.nextCursor !== "string" || result.nextCursor.length === 0 || cursors.has(result.nextCursor)) {
      fail("tools/list cursors must be non-empty and unique", "tool_catalog_invalid");
    }
    if (Buffer.byteLength(result.nextCursor) > MAX_CURSOR_BYTES) fail(`tool cursor exceeds ${MAX_CURSOR_BYTES} bytes`, "limit_exceeded");
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  fail("tools/list exceeded 16 pages", "limit_exceeded");
}

function validateCallResult(value) {
  const result = object(value, "tools/call result");
  if (!Array.isArray(result.content)) fail("tools/call result must contain a content array");
  if (result.content.length > MAX_CONTENT_ITEMS) fail(`tools/call returned more than ${MAX_CONTENT_ITEMS} content items`, "limit_exceeded");
  if (result.isError !== undefined && typeof result.isError !== "boolean") fail("tools/call isError must be boolean");
}

export async function runOperation(artifact, operation, { fixtures = false, fixtureScenario } = {}) {
  const home = await mkdtemp(resolve(tmpdir(), "paybox-plugin-conformance-"));
  try {
    const args = fixtures ? ["--import", resolve(dirname(artifact), "../tests/network-fixtures.mjs"), artifact] : [artifact];
    return await withProcess(process.execPath, args, {
      cwd: dirname(artifact),
      env: {
        HOME: home, NODE_ENV: "production", NO_COLOR: "1", PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        ...(fixtureScenario === undefined ? {} : { POLYSCOPE_TEST_SCENARIO: fixtureScenario }),
      },
    }, async (child, closed, stop) => {
      let stdoutBytes = 0;
      let stderrBytes = 0;
      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_STDOUT_BYTES) stop(`plugin stdout exceeded ${MAX_STDOUT_BYTES} bytes`, "limit_exceeded");
      });
      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > MAX_STDERR_BYTES) stop(`plugin stderr exceeded ${MAX_STDERR_BYTES} bytes`, "limit_exceeded");
      });
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      try {
        send(child, {
          jsonrpc: "2.0", id: 2, method: operation.method,
          params: { ...operation.params, _meta: {
            "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": { name: "paybox-plugin-conformance", version: release.version },
            "io.modelcontextprotocol/clientCapabilities": {},
          } },
        });
        return await receive(lines[Symbol.asyncIterator](), 2);
      } catch (error) {
        if (error.code === "startup_failed") await closed;
        throw error;
      } finally { lines.close(); }
    }, OPERATION_TIMEOUT_MS);
  } finally { await rm(home, { recursive: true, force: true }); }
}

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function receive(messages, expectedId) {
  for (;;) {
    const next = await messages.next();
    if (next.done) fail("plugin exited before returning an MCP response", "startup_failed");
    let message;
    try {
      message = JSON.parse(next.value);
    } catch {
      fail("plugin stdout contained non-JSON output");
    }
    if (message?.jsonrpc !== "2.0" || typeof message !== "object" || Array.isArray(message)) {
      fail("plugin returned an invalid JSON-RPC message");
    }
    if (!("id" in message)) continue;
    if (message.id !== expectedId) fail("plugin response id did not match request");
    if (("result" in message) === ("error" in message)) fail("plugin response must contain exactly one of result or error");
    if ("error" in message) fail("plugin returned a JSON-RPC error", "tool_failed");
    if (message.result?.resultType !== "complete") fail("MCP 2026-07-28 resultType must be complete");
    return message;
  }
}

function object(value, label, code = "protocol_invalid") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`, code);
  return value;
}

function containsKey(value, key) {
  if (Array.isArray(value)) return value.some((entry) => containsKey(entry, key));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([entryKey, entry]) => entryKey === key || containsKey(entry, key));
}

function fail(message, code = "protocol_invalid") {
  throw new ConformanceError(message, code);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  await reportConformance(() => testArtifact());
}
