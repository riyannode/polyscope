import { prepareLimitOrder } from "@polymarket/client/actions";
import { createSecureClient } from "@polymarket/client";
import { createHash } from "node:crypto";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { decodeFunctionData, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount as accountFromKey } from "viem/accounts";

import { checkEnvironment, ConformanceError, release, reportConformance } from "./report.mjs";
import { withProcess } from "./process.mjs";
import { compileSchema, validateSample as validateSchemaSample } from "./schema.mjs";

const accounts = new Map();
const authFixtures = new Map();
const walletFixtures = new Map();
function privateKeyToAccount(key) { const account = accountFromKey(key); accounts.set(account.address.toLowerCase(), account); return account; }
const fixtureSigner = privateKeyToAccount(generatePrivateKey());
async function fixtureWallet(signerAddress) {
  if (walletFixtures.has(signerAddress)) return walletFixtures.get(signerAddress);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "relayer-v2.polymarket.com" && url.pathname === "/deployed") return Response.json({ deployed: true });
    if (url.hostname === "clob.polymarket.com" && url.pathname === "/auth/api-keys") return Response.json({ apiKeys: ["fixture-api-key"] });
    throw new Error("Unexpected SDK fixture wallet request");
  };
  try {
    const blocked = async () => { throw new Error("Fixture must not sign or send"); };
    const client = await createSecureClient({ credentials: { key: "fixture-api-key", secret: "dGVzdA==", passphrase: "fixture-passphrase" },
      signer: { getAddress: async () => signerAddress, signMessage: blocked, signTypedData: blocked, sendTransaction: blocked } });
    walletFixtures.set(signerAddress, client.account.wallet);
    return client.account.wallet;
  } finally { globalThis.fetch = originalFetch; }
}
async function sdkReferenceOrder(account, wallet) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/deployed") return Response.json({ deployed: true });
    if (url.pathname === "/auth/api-keys") return Response.json({ apiKeys: ["fixture-api-key"] });
    if (url.pathname.startsWith("/markets-by-token/")) return Response.json({ condition_id: `0x${"1".repeat(64)}` });
    if (url.pathname.startsWith("/clob-markets/")) return Response.json({ fd: { r: 0.05, e: 1 }, mts: 0.01, nr: false, t: [{ t: "123", o: "Yes" }, { t: "124", o: "No" }] });
    throw new Error("Unexpected SDK reference request");
  };
  try {
    const blocked = async () => { throw new Error("Reference workflow must not send"); };
    const client = await createSecureClient({ wallet, credentials: { key: "fixture-api-key", secret: "dGVzdA==", passphrase: "fixture-passphrase" },
      signer: { getAddress: async () => account.address, signTypedData: blocked, signMessage: blocked, sendTransaction: blocked } });
    const workflow = await prepareLimitOrder(client, { assetId: "123", side: "BUY", price: "0.50", size: "10" });
    const step = await workflow.next();
    const typedData = JSON.parse(JSON.stringify(step.value.payload, (_key, value) => typeof value === "bigint" ? value.toString() : value));
    const signature = await account.signTypedData(step.value.payload);
    const result = await workflow.next(signature);
    if (!result.done) throw new Error("SDK reference did not finish unsigned preparation");
    return { typedData, signature, sdkSignature: result.value.signature };
  } finally { globalThis.fetch = originalFetch; }
}
async function fixtureAuth(args) {
  if (args.walletType === "DEPOSIT_WALLET" && args.makerAddress === "0x0000000000000000000000000000000000000002") args.makerAddress = await fixtureWallet(args.signingAddress);
  if (args.clobAuth) return;
  const signer = accounts.get((args.signingAddress ?? args.signerAddress ?? "").toLowerCase()) ?? fixtureSigner;
  const timestamp = "1800000000";
  const nonce = "0";
  const signature = await signer.signTypedData({ domain: { name: "ClobAuthDomain", version: "1", chainId: 137 },
    types: { ClobAuth: [{ name: "address", type: "address" }, { name: "timestamp", type: "string" }, { name: "nonce", type: "uint256" }, { name: "message", type: "string" }] }, primaryType: "ClobAuth",
    message: { address: signer.address, timestamp, nonce: 0n, message: "This message attests that I control the given wallet" } });
  args.clobAuth = { timestamp, nonce, signature };
  authFixtures.set(signer.address.toLowerCase(), args.clobAuth);
}
function validateSample(tool, args, result) {
  if (["prepare_order_signing", "prepare_redeem"].includes(tool.name) && !args.clobAuth) args.clobAuth = authFixtures.get((args.signingAddress ?? fixtureSigner.address).toLowerCase());
  return validateSchemaSample(tool, args, result);
}

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
const ctfRedeemAbi = parseAbi(["function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)"]);
const v2RedeemAbi = parseAbi(["function redeem(bytes31 conditionId, uint256 outcomeIndex, uint256 amount)"]);
const textOnlyToolCoverage = new Set();

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
  checks.push({ tool: "prepare_order_signing", status: "not_run", reason: "SDK preparation requires signed ClobAuth; live signing is outside local conformance. Fixture coverage runs in pnpm test." });
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
  readTextOnlyResult(response.result, tool.name);
  validateSample(tool, argumentsValue, response.result);
  return response.result;
}

function readTextOnlyResult(value, toolName) {
  const response = object(value, `${toolName} text-only tools/call result`);
  if (!Array.isArray(response.content)) fail(`${toolName} did not return content for a text-only client`, "text_output_invalid");
  const textItems = response.content.filter((item) => item && typeof item === "object" && item.type === "text");
  if (textItems.length !== 1 || typeof textItems[0].text !== "string") {
    fail(`${toolName} must return exactly one text response`, "text_output_invalid");
  }
  let decoded;
  try { decoded = JSON.parse(textItems[0].text); }
  catch { fail(`${toolName} text response must be machine-readable JSON`, "text_output_invalid"); }
  const envelope = object(decoded, `${toolName} text response`, "text_output_invalid");
  if (envelope.tool !== toolName) fail(`${toolName} text response has the wrong tool label`, "text_output_invalid");
  if (typeof envelope.result !== "object" || envelope.result === null || Array.isArray(envelope.result)) {
    fail(`${toolName} text response must contain an object result`, "text_output_invalid");
  }
  if (/(?:SECRET_SENTINEL|"(?:apiKey|secret|passphrase|authorization|privateKey)"\s*:)/i.test(textItems[0].text)) {
    fail(`${toolName} text response exposed credential material`, "text_output_secret");
  }
  textOnlyToolCoverage.add(toolName);
  return envelope.result;
}

async function callTextOnlyTool(artifact, toolName, argumentsValue, options = {}) {
  const response = await runOperation(artifact, {
    method: "tools/call", params: { name: toolName, arguments: argumentsValue },
  }, options);
  validateCallResult(response.result);
  if (response.result.isError === true) fail(`${toolName} text-only call returned isError: true`, "tool_failed");
  return readTextOnlyResult(response.result, toolName);
}

async function testTextOnlyOrderWorkflow(artifact) {
  const signer = privateKeyToAccount(generatePrivateKey());
  const markets = await callTextOnlyTool(artifact, "search_markets", { query: "Sample market", limit: 3 }, { fixtures: true });
  const market = markets.markets.find((item) => item.acceptingOrders === true && item.outcomes.length > 0);
  if (!market || !market.marketId || !market.conditionId || !market.outcomes[0].assetId
    || "resolutionRules" in market || "resolutionSource" in market) {
    fail("compact text-only market search omitted actionable IDs or included full resolution rules", "text_output_invalid");
  }
  const outcome = market.outcomes[0];
  const quote = await callTextOnlyTool(artifact, "get_quote", {
    marketId: market.marketId, assetId: outcome.assetId, side: "BUY", size: "10", depth: 5,
  }, { fixtures: true });
  if (quote.marketId !== market.marketId || quote.assetId !== outcome.assetId || quote.outcome !== outcome.name
    || quote.side !== "BUY" || quote.tickSize === undefined || quote.minOrderSize === undefined
    || quote.estimatedFeePusd === undefined || quote.bookAgeMs === undefined) {
    fail("text-only quote omitted fields required to prepare the next order", "text_output_invalid");
  }

  const clobAuth = await callTextOnlyTool(artifact, "prepare_clob_auth", { signerAddress: signer.address, nonce: "0" }, { fixtures: true });
  if (clobAuth.typedData?.primaryType !== "ClobAuth" || JSON.stringify(clobAuth.typedData) !== JSON.stringify(clobAuth.requestWalletSignIntent?.typedData)) {
    fail("text-only ClobAuth response omitted its exact PayBox signing payload", "text_output_invalid");
  }
  const clobAuthSignature = await signer.signTypedData(clobAuth.typedData);
  const clobAuthValidation = await callTextOnlyTool(artifact, "validate_clob_auth_signature", {
    signerAddress: signer.address, timestamp: clobAuth.timestamp, nonce: clobAuth.nonce, signature: clobAuthSignature,
  }, { fixtures: true });
  if (clobAuthValidation.valid !== true || clobAuthValidation.expectedSignerAddress.toLowerCase() !== signer.address.toLowerCase()) {
    fail("text-only ClobAuth validation did not preserve its signer result", "text_output_invalid");
  }
  const auth = { timestamp: clobAuth.timestamp, nonce: clobAuth.nonce, signature: clobAuthSignature };
  const prepared = await callTextOnlyTool(artifact, "prepare_order_signing", {
    marketId: market.marketId, assetId: outcome.assetId,
    makerAddress: signer.address, signingAddress: signer.address, clobAuth: auth,
    walletType: "EOA", side: "BUY", priceLimit: "0.50", size: "10", maxNominalPusd: "5.13",
  }, { fixtures: true });
  if (prepared.status !== "PREPARED" || prepared.preparedOrder.order.orderType !== "FAK"
    || prepared.preparedOrder.wallet.makerAddress.toLowerCase() !== signer.address.toLowerCase()
    || JSON.stringify(prepared.preparedOrder.typedData) !== JSON.stringify(prepared.requestWalletSignIntent?.typedData)) {
    fail("text-only order preparation omitted wallet binding, FAK default, or exact EIP-712 data", "text_output_invalid");
  }
  const orderSignature = await signer.signTypedData(prepared.requestWalletSignIntent.typedData);
  const orderValidation = await callTextOnlyTool(artifact, "validate_order_signature", {
    preparedOrder: prepared.preparedOrder, signature: orderSignature,
  }, { fixtures: true });
  if (orderValidation.localSignerVerified !== true || "signedOrderSignature" in orderValidation) {
    fail("text-only order validation omitted its result or exposed the signed signature", "text_output_invalid");
  }
  const submitted = await callTextOnlyTool(artifact, "submit_order", {
    preparedOrder: prepared.preparedOrder, orderSignature, clobAuth: auth, orderType: "FAK",
  }, { fixtures: true, fixtureScenario: "submit-valid", expectedSignerAddress: signer.address, expectedMakerAddress: signer.address });
  if (submitted.status !== "SUBMITTED" || submitted.orderType !== "FAK" || !submitted.orderId) {
    fail("text-only FAK submission did not return its authoritative provider response fields", "text_output_invalid");
  }

  const fokPrepared = await callTextOnlyTool(artifact, "prepare_order_signing", {
    marketId: market.marketId, assetId: outcome.assetId,
    makerAddress: signer.address, signingAddress: signer.address, clobAuth: auth,
    walletType: "EOA", side: "BUY", orderType: "FOK", priceLimit: "0.50", size: "10", maxNominalPusd: "5.13",
  }, { fixtures: true });
  const fokSignature = await signer.signTypedData(fokPrepared.requestWalletSignIntent.typedData);
  const fokRejected = await callTextOnlyTool(artifact, "submit_order", {
    preparedOrder: fokPrepared.preparedOrder, orderSignature: fokSignature, clobAuth: auth, orderType: "FOK",
  }, { fixtures: true, fixtureScenario: "submit-fok-insufficient-depth", expectedSignerAddress: signer.address, expectedMakerAddress: signer.address });
  if (fokRejected.status !== "REJECTED" || fokRejected.orderType !== "FOK" || !fokRejected.message.includes("FOK")) {
    fail("text-only FOK response did not preserve the provider's FOK rejection", "text_output_invalid");
  }
}

export async function testOfflineArtifact(root = process.cwd()) {
  const artifact = resolve(root, "dist/plugin.mjs");
  const tools = await listTools(artifact);
  const discovered = await runOperation(artifact, { method: "tools/list", params: {} }, { fixtures: true, fixtureScenario: "discovery-no-network" });
  if (discovered.result.tools.length !== tools.length) fail("fixture discovery changed the catalog", "tool_catalog_invalid");
  textOnlyToolCoverage.clear();
  if (tools.length !== 16) fail(`expected 16 MCP tools, received ${tools.length}`, "tool_catalog_invalid");
  const removedSchemaFields = ["ExecutionApproval", "executionApprovalSignature", "executionApprovalSigningIntent", "marketRestricted", "accountGeoblockChecked"];
  for (const tool of tools) {
    const schemas = JSON.stringify({ inputSchema: tool.inputSchema, outputSchema: tool.outputSchema });
    if (removedSchemaFields.some((field) => schemas.includes(field))) {
      fail(`${tool.name} schema contains a removed trading-policy field`, "tool_catalog_invalid");
    }
  }
  const prepareTool = tools.find((tool) => tool.name === "prepare_order_signing");
  if (!prepareTool) fail("prepare_order_signing was not returned by tools/list", "tool_catalog_invalid");
  const searchTool = tools.find((tool) => tool.name === "search_markets");
  const search = await callTool(artifact, searchTool, { query: "Sample market", limit: 3 }, { fixtures: true });
  if (search.structuredContent.markets.length !== 1 || "marketRestricted" in search.structuredContent.markets[0]) {
    fail("market search exposed Gamma restricted metadata", "market_output_invalid");
  }
  const submitTool = tools.find((tool) => tool.name === "submit_fak_order");
  if (!submitTool) fail("submit_fak_order was not returned by tools/list", "tool_catalog_invalid");
  const submitOrderTool = tools.find((tool) => tool.name === "submit_order");
  if (!submitOrderTool) fail("submit_order was not returned by tools/list", "tool_catalog_invalid");
  if (submitOrderTool.inputSchema.properties.orderType?.enum?.join(",") !== "FAK,FOK") {
    fail("submit_order did not expose the exact FAK/FOK choices", "schema_invalid");
  }
  await testTextOnlyOrderWorkflow(artifact);
  if ("executionApprovalSignature" in submitTool.inputSchema.properties) {
    fail("submit schema still requires a PolyScope execution approval signature", "schema_invalid");
  }
  const base = {
    marketId: "1", assetId: "123",
    makerAddress: fixtureSigner.address,
    signingAddress: fixtureSigner.address,
    walletType: "EOA", size: "10", maxNominalPusd: "5.13",
  };
  const buy = await callTool(artifact, prepareTool, { ...base, side: "BUY", priceLimit: "0.50" }, { fixtures: true });
  const buyOrder = buy.structuredContent.preparedOrder.order;
  const orderIntent = buy.structuredContent.requestWalletSignIntent;
  if (orderIntent?.op !== "typedData" || typeof orderIntent.typedData !== "object"
    || orderIntent.typedData.primaryType !== "Order" || !orderIntent.typedData.domain || !orderIntent.typedData.types || !orderIntent.typedData.message) {
    fail("order signing intent did not match PayBox's documented EIP-712 object contract", "wallet_intent_invalid");
  }
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
  const noVisibleLiquidity = await callTool(artifact, prepareTool, { ...base, side: "BUY", priceLimit: "0.50" }, {
    fixtures: true, fixtureScenario: "no-visible-liquidity",
  });
  if (noVisibleLiquidity.structuredContent.status !== "PREPARED"
    || noVisibleLiquidity.structuredContent.preparedOrder.order.price !== "0.50"
    || noVisibleLiquidity.structuredContent.preparedOrder.order.orderType !== "FAK") {
    fail("lack of visible liquidity added a PolyScope preparation rejection or changed the signed limit", "liquidity_policy_invalid");
  }
  const replaySigner = privateKeyToAccount(generatePrivateKey());
  const fokEoaPreparation = await callTool(artifact, prepareTool, {
    ...base, makerAddress: replaySigner.address, signingAddress: replaySigner.address,
    side: "SELL", priceLimit: "0.49", orderType: "FOK",
  }, { fixtures: true });
  const fokEoaOrder = fokEoaPreparation.structuredContent.preparedOrder.order;
  if (fokEoaOrder.orderType !== "FOK" || fokEoaOrder.side !== "SELL" || fokEoaOrder.price !== "0.49"
    || fokEoaOrder.size !== "10" || fokEoaOrder.makerAmount !== "10000000" || fokEoaOrder.takerAmount !== "4900000"
    || fokEoaPreparation.structuredContent.preparedOrder.wallet.signatureType !== 0) {
    fail("EOA FOK preparation changed the selected type, side, exact price, size, amounts, or signature type", "order_policy_invalid");
  }
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
  if (validOrderSignature.structuredContent.localSignerVerified !== true
    || validOrderSignature.structuredContent.contractWalletAcceptance !== "NOT_APPLICABLE") {
    fail("metadata-free prepared order did not validate its unchanged Polymarket EIP-712 signature", "signature_validation_invalid");
  }
  const futureOrderTimestamp = String(Date.now() + 60_000);
  const futureTimestampPrepared = {
    ...replayPrepared,
    order: { ...replayPrepared.order, timestamp: futureOrderTimestamp },
    typedData: { ...replayPrepared.typedData, message: { ...replayPrepared.typedData.message, timestamp: futureOrderTimestamp } },
  };
  const futureTimestampValidation = await callTool(artifact, validateOrderTool, {
    preparedOrder: futureTimestampPrepared,
    signature: await replaySigner.signTypedData(futureTimestampPrepared.typedData),
  }, { fixtures: true });
  if (futureTimestampValidation.structuredContent.localSignerVerified !== true) {
    fail("an undocumented order-timestamp freshness gate rejected a correctly signed order", "order_timestamp_invalid");
  }
  const metadataOnlyChange = await callTool(artifact, validateOrderTool, {
    preparedOrder: { ...replayPrepared, market: { ...replayPrepared.market, bookTimestamp: "1" } }, signature: orderSignature,
  }, { fixtures: true });
  if (metadataOnlyChange.structuredContent.localSignerVerified !== true) {
    fail("changing unsigned book-age metadata changed Polymarket EIP-712 signature validation", "order_hash_invalid");
  }
  const clobAuthTool = tools.find((tool) => tool.name === "prepare_clob_auth");
  const clobAuthResult = await callTool(artifact, clobAuthTool, { signerAddress: replaySigner.address, nonce: "0" }, { fixtures: true });
  const authIntent = clobAuthResult.structuredContent.requestWalletSignIntent;
  if (authIntent?.op !== "typedData" || typeof authIntent.typedData !== "object"
    || authIntent.typedData.primaryType !== "ClobAuth" || !authIntent.typedData.domain || !authIntent.typedData.types || !authIntent.typedData.message) {
    fail("ClobAuth signing intent did not match PayBox's documented EIP-712 object contract", "wallet_intent_invalid");
  }
  if (Math.abs(Number(clobAuthResult.structuredContent.timestamp) * 1000 - Date.now()) > 5000) fail("SDK ClobAuth timestamp is not current", "clob_auth_time_invalid");
  const clobAuth = {
    timestamp: clobAuthResult.structuredContent.timestamp,
    nonce: clobAuthResult.structuredContent.nonce,
    signature: await replaySigner.signTypedData(clobAuthResult.structuredContent.typedData),
  };
  const validateClobAuthTool = tools.find((tool) => tool.name === "validate_clob_auth_signature");
  const freshAuthValidation = await callTool(artifact, validateClobAuthTool, {
    signerAddress: replaySigner.address, ...clobAuth,
  }, { fixtures: true });
  if (freshAuthValidation.structuredContent.valid !== true) {
    fail("fresh ClobAuth signature did not recover to its owner EOA", "clob_auth_signature_invalid");
  }
  const submitArgs = { preparedOrder: replayPrepared, orderSignature, clobAuth };
  const successfulSubmit = await callTool(artifact, submitTool, submitArgs, {
    fixtures: true, fixtureScenario: "submit-valid", expectedSignerAddress: replaySigner.address,
  });
  if (successfulSubmit.structuredContent.status !== "SUBMITTED" || !successfulSubmit.structuredContent.orderId) {
    fail("a valid signed FAK order without ExecutionApproval did not reach one intercepted CLOB POST", "submit_invalid");
  }
  for (const orderType of ["FAK", "FOK"]) {
    const exact = await callTool(artifact, prepareTool, { ...base, makerAddress: replaySigner.address, signingAddress: replaySigner.address,
      clobAuth, side: "BUY", priceLimit: "0.50", size: "5", maxNominalPusd: "2.57", orderType }, { fixtures: true });
    const prepared = exact.structuredContent.preparedOrder;
    if (prepared.order.size !== "5" || prepared.order.takerAmount !== "5000000" || prepared.order.makerAmount !== "2500000"
      || prepared.order.maxNominalPusd !== "2.57" || prepared.wallet.signatureType !== 0) fail("SDK changed the exact five-share intent", "order_policy_invalid");
    const submitted = await callTool(artifact, submitOrderTool, { preparedOrder: prepared, orderType, clobAuth,
      orderSignature: await replaySigner.signTypedData(prepared.typedData) }, { fixtures: true, fixtureScenario: `submit-exact-five-${orderType.toLowerCase()}`, expectedSignerAddress: replaySigner.address });
    if (submitted.structuredContent.status !== "SUBMITTED" || submitted.structuredContent.requestedSize !== "5" || submitted.structuredContent.orderType !== orderType) fail("exact five-share SDK submission failed", "order_policy_invalid");
    const rejected = await callTool(artifact, prepareTool, { ...base, makerAddress: replaySigner.address, signingAddress: replaySigner.address,
      clobAuth, side: "BUY", priceLimit: "0.50", size: "5", maxNominalPusd: "2.56", orderType }, { fixtures: true });
    if (rejected.structuredContent.status !== "REJECTED" || rejected.structuredContent.errorCode !== "PS_SPENDING_CAP" || "preparedOrder" in rejected.structuredContent) fail("fee cap caused a silent BUY resize", "order_policy_invalid");
  }
  const l1RejectedSubmit = await callTool(artifact, submitTool, submitArgs, {
    fixtures: true, fixtureScenario: "submit-rejected-l1-auth", expectedSignerAddress: replaySigner.address,
  });
  if (l1RejectedSubmit.structuredContent.status !== "FAILED" || l1RejectedSubmit.structuredContent.errorCode !== "PS_CLOB_AUTH_REJECTED"
    || l1RejectedSubmit.structuredContent.httpStatus !== 401
    || !/prepare and sign a new ClobAuth/i.test(l1RejectedSubmit.structuredContent.message)) {
    fail("fresh ClobAuth HTTP 401 did not fail closed with explicit re-sign guidance", "clob_auth_recovery_invalid");
  }
  if (JSON.stringify(l1RejectedSubmit.structuredContent).includes("SECRET_SENTINEL")) {
    fail("L1 authentication failure exposed provider body data", "clob_auth_sanitization_invalid");
  }
  const existingApiKeySubmit = await callTool(artifact, submitTool, submitArgs, {
    fixtures: true, fixtureScenario: "existing-api-key", expectedSignerAddress: replaySigner.address,
  });
  if (existingApiKeySubmit.structuredContent.status !== "SUBMITTED" || !existingApiKeySubmit.structuredContent.orderId) {
    fail("existing CLOB account did not create then derive credentials before its single FAK submission", "clob_auth_creation_invalid");
  }
  const invalidClobAuth = await callTool(artifact, submitTool, {
    ...submitArgs, clobAuth: { ...clobAuth, signature: `0x${"0".repeat(130)}` },
  }, { fixtures: true, fixtureScenario: "invalid-clob-auth" });
  if (invalidClobAuth.structuredContent.status !== "FAILED"
    || invalidClobAuth.structuredContent.errorCode !== "PS_AUTH_SIGNATURE_INVALID"
    || !/prepare and sign a new ClobAuth/i.test(invalidClobAuth.structuredContent.message)) {
    fail("locally invalid ClobAuth did not fail closed with re-sign guidance", "clob_auth_signature_invalid");
  }
  for (const [scenario, age] of [["restricted-submit", 0], ["submit-stale-book", 51_000], ["submit-future-book", null], ["missing-book-timestamp", null]]) {
    const result = await callTool(artifact, submitTool, submitArgs, { fixtures: true, fixtureScenario: scenario });
    if (result.structuredContent.status !== "SUBMITTED") {
      fail(`${scenario} alone incorrectly blocked a signed limit-bounded FAK order`, "submit_preflight_invalid");
    }
    if (age > 0 && result.structuredContent.errorCode !== null) fail("stale informational book age created an execution error", "submit_preflight_invalid");
  }
  const depositSigner = privateKeyToAccount(generatePrivateKey());
  const depositOrder = await callTool(artifact, prepareTool, {
    ...base, makerAddress: "0x0000000000000000000000000000000000000002",
    signingAddress: depositSigner.address, walletType: "DEPOSIT_WALLET", side: "BUY", priceLimit: "0.50",
  }, { fixtures: true });
  const depositPrepared = depositOrder.structuredContent.preparedOrder;
  if (depositPrepared.wallet.signatureType !== 3
    || depositPrepared.wallet.makerAddress.toLowerCase() !== (await fixtureWallet(depositSigner.address)).toLowerCase()
    || depositPrepared.wallet.signingAddress.toLowerCase() !== depositSigner.address.toLowerCase()
    || depositPrepared.wallet.orderSignerAddress.toLowerCase() !== depositPrepared.wallet.makerAddress.toLowerCase()) {
    fail("Deposit Wallet owner EOA, maker, order signer, and signature type were not kept distinct and consistent", "deposit_wallet_identity_invalid");
  }
  const depositOrderSignature = await depositSigner.signTypedData(depositPrepared.typedData);
  const depositValidation = await callTool(artifact, validateOrderTool, {
    preparedOrder: depositPrepared, signature: depositOrderSignature,
  }, { fixtures: true });
  if (depositValidation.structuredContent.localSignerVerified !== true
    || depositValidation.structuredContent.contractWalletAcceptance !== "DEFERRED_TO_CLOB"
    || (depositValidation.structuredContent.signedOrderSignature?.length ?? 0) <= depositOrderSignature.length) {
    fail("Deposit Wallet signer recovery or ERC-7739 wrapping was not reported distinctly from CLOB contract acceptance", "deposit_wallet_signature_invalid");
  }
  const reference = await sdkReferenceOrder(depositSigner, depositPrepared.wallet.makerAddress);
  const referenceMessage = reference.typedData.message.contents;
  const referencePrepared = { ...depositPrepared, typedData: reference.typedData,
    order: { ...depositPrepared.order, salt: referenceMessage.salt, timestamp: referenceMessage.timestamp } };
  const referenceValidation = await callTool(artifact, validateOrderTool, { preparedOrder: referencePrepared, signature: reference.signature }, { fixtures: true });
  if (referenceValidation.structuredContent.signedOrderSignature !== reference.sdkSignature) fail("stateless Deposit Wallet finalizer differs from official SDK output", "deposit_wallet_signature_invalid");
  const depositAuthResult = await callTool(artifact, clobAuthTool, { signerAddress: depositSigner.address, nonce: "0" }, { fixtures: true });
  const depositClobAuth = {
    timestamp: depositAuthResult.structuredContent.timestamp,
    nonce: depositAuthResult.structuredContent.nonce,
    signature: await depositSigner.signTypedData(depositAuthResult.structuredContent.typedData),
  };
  const depositSubmit = await callTool(artifact, submitOrderTool, {
    preparedOrder: depositPrepared, orderSignature: depositOrderSignature, clobAuth: depositClobAuth, orderType: "FAK",
  }, {
    fixtures: true, fixtureScenario: "submit-deposit-wallet",
    expectedSignerAddress: depositSigner.address, expectedMakerAddress: depositPrepared.wallet.makerAddress,
  });
  if (depositSubmit.structuredContent.status !== "SUBMITTED") {
    fail("valid Deposit Wallet signing data did not reach its single intercepted CLOB POST without Polygon RPC", "deposit_wallet_submit_invalid");
  }
  const fokEoaSignature = await replaySigner.signTypedData(fokEoaPreparation.structuredContent.preparedOrder.typedData);
  const fokEoaSubmit = await callTool(artifact, submitOrderTool, {
    preparedOrder: fokEoaPreparation.structuredContent.preparedOrder,
    orderSignature: fokEoaSignature, clobAuth, orderType: "FOK",
  }, { fixtures: true, fixtureScenario: "submit-fok-eoa", expectedSignerAddress: replaySigner.address, expectedMakerAddress: replaySigner.address });
  if (fokEoaSubmit.structuredContent.status !== "SUBMITTED" || fokEoaSubmit.structuredContent.orderType !== "FOK") {
    fail("EOA FOK submission did not preserve FOK through the single CLOB request", "submit_invalid");
  }
  const depositFokPreparation = await callTool(artifact, prepareTool, {
    ...base, makerAddress: "0x0000000000000000000000000000000000000002",
    signingAddress: depositSigner.address, walletType: "DEPOSIT_WALLET", side: "BUY", priceLimit: "0.50", orderType: "FOK",
  }, { fixtures: true });
  const depositFokOrderSignature = await depositSigner.signTypedData(depositFokPreparation.structuredContent.preparedOrder.typedData);
  const depositFokSubmit = await callTool(artifact, submitOrderTool, {
    preparedOrder: depositFokPreparation.structuredContent.preparedOrder,
    orderSignature: depositFokOrderSignature, clobAuth: depositClobAuth, orderType: "FOK",
  }, { fixtures: true, fixtureScenario: "submit-fok-deposit-wallet", expectedSignerAddress: depositSigner.address,
    expectedMakerAddress: depositFokPreparation.structuredContent.preparedOrder.wallet.makerAddress });
  if (depositFokSubmit.structuredContent.status !== "SUBMITTED" || depositFokSubmit.structuredContent.orderType !== "FOK") {
    fail("Deposit Wallet FOK submission did not preserve its wrapped signature and FOK type", "deposit_wallet_submit_invalid");
  }
  const shallowFok = await callTool(artifact, prepareTool, {
    ...base, side: "BUY", priceLimit: "0.50", orderType: "FOK",
  }, { fixtures: true, fixtureScenario: "submit-fok-insufficient-depth" });
  if (shallowFok.structuredContent.status !== "PREPARED" || shallowFok.structuredContent.preparedOrder.order.orderType !== "FOK") {
    fail("insufficient visible book depth was treated as a local guarantee or changed the FOK preparation", "fok_depth_invalid");
  }
  const shallowFokSignature = await replaySigner.signTypedData(shallowFok.structuredContent.preparedOrder.typedData);
  const shallowFokSubmit = await callTool(artifact, submitOrderTool, {
    preparedOrder: shallowFok.structuredContent.preparedOrder,
    orderSignature: shallowFokSignature, clobAuth, orderType: "FOK",
  }, { fixtures: true, fixtureScenario: "submit-fok-insufficient-depth", expectedSignerAddress: replaySigner.address });
  if (shallowFokSubmit.structuredContent.status !== "REJECTED" || shallowFokSubmit.structuredContent.orderType !== "FOK") {
    fail("Polymarket's insufficient-depth FOK rejection was not reported as a FOK rejection", "fok_depth_invalid");
  }
  const mismatchedLegacy = await callTool(artifact, submitTool, {
    preparedOrder: fokEoaPreparation.structuredContent.preparedOrder, orderSignature: fokEoaSignature, clobAuth,
  }, { fixtures: true, fixtureScenario: "submit-type-mismatch" });
  if (mismatchedLegacy.structuredContent.status !== "REJECTED" || mismatchedLegacy.structuredContent.orderType !== "FAK"
    || mismatchedLegacy.structuredContent.errorCode !== "PS_ORDER_TYPE_MISMATCH") {
    fail("legacy submit_fak_order silently changed a prepared FOK order", "order_type_compatibility_invalid");
  }
  const ambiguousFok = await callTool(artifact, submitOrderTool, {
    preparedOrder: fokEoaPreparation.structuredContent.preparedOrder,
    orderSignature: fokEoaSignature, clobAuth, orderType: "FOK",
  }, { fixtures: true, fixtureScenario: "submit-fok-ambiguous-503", expectedSignerAddress: replaySigner.address });
  if (ambiguousFok.structuredContent.status !== "UNKNOWN" || ambiguousFok.structuredContent.orderType !== "FOK"
    || ambiguousFok.structuredContent.httpStatus !== 503) {
    fail("ambiguous FOK POST did not stay UNKNOWN after one submission and one reconciliation read", "ambiguous_submit_invalid");
  }
  const statusTool = tools.find((tool) => tool.name === "get_order_status");
  const cancelTool = tools.find((tool) => tool.name === "cancel_order");
  const statusOrderId = `0x${"a".repeat(64)}`;
  const l1DerivationRejected = await callTool(artifact, statusTool, {
    orderId: statusOrderId, requestedSize: "10", signerAddress: replaySigner.address, clobAuth,
  }, { fixtures: true, fixtureScenario: "l1-derive-401", expectedSignerAddress: replaySigner.address });
  if (l1DerivationRejected.structuredContent.errorCode !== "PS_CLOB_AUTH_REJECTED"
    || l1DerivationRejected.structuredContent.httpStatus !== 401
    || !/prepare and sign a new ClobAuth/i.test(l1DerivationRejected.structuredContent.message)) {
    fail("HTTP 401 from L1 derivation was not distinguished from an order read failure", "clob_l1_failure_invalid");
  }
  const l2Rejected = await callTool(artifact, statusTool, {
    orderId: statusOrderId, requestedSize: "10", signerAddress: replaySigner.address, clobAuth,
  }, { fixtures: true, fixtureScenario: "order-status-l2-401", expectedSignerAddress: replaySigner.address });
  if (l2Rejected.structuredContent.errorCode !== "PS_CLOB_PRIVATE_AUTH_REJECTED"
    || l2Rejected.structuredContent.httpStatus !== 401) {
    fail("HTTP 401 from an authenticated order read was hidden as an unknown order status", "clob_l2_failure_invalid");
  }
  if (JSON.stringify(l2Rejected.structuredContent).includes("SECRET_SENTINEL")) {
    fail("L2 authentication failure exposed provider body data", "clob_l2_sanitization_invalid");
  }
  const missingOrder = await callTool(artifact, statusTool, {
    orderId: statusOrderId, requestedSize: "10", signerAddress: replaySigner.address, clobAuth, orderType: "FOK",
  }, { fixtures: true, fixtureScenario: "order-status-404", expectedSignerAddress: replaySigner.address });
  if (missingOrder.structuredContent.errorCode !== "PS_ORDER_NOT_FOUND" || missingOrder.structuredContent.httpStatus !== 404
    || missingOrder.structuredContent.orderType !== "FOK") {
    fail("HTTP 404 for a nonexistent FOK order did not retain its requested type", "clob_order_not_found_invalid");
  }
  const statusUnavailable = await callTool(artifact, statusTool, {
    orderId: statusOrderId, requestedSize: "10", signerAddress: replaySigner.address, clobAuth,
  }, { fixtures: true, fixtureScenario: "order-status-503", expectedSignerAddress: replaySigner.address });
  if (statusUnavailable.structuredContent.errorCode !== "PS_PROVIDER_UNAVAILABLE" || statusUnavailable.structuredContent.httpStatus !== 503) {
    fail("HTTP 503 on an order read was not returned as a provider availability failure", "clob_order_unavailable_invalid");
  }
  const statusTimeout = await callTool(artifact, statusTool, {
    orderId: statusOrderId, requestedSize: "10", signerAddress: replaySigner.address, clobAuth,
  }, { fixtures: true, fixtureScenario: "order-status-timeout", expectedSignerAddress: replaySigner.address });
  if (statusTimeout.structuredContent.errorCode !== "PS_PROVIDER_TIMEOUT") {
    fail("order-status transport timeout was not distinguished from a missing order", "clob_order_timeout_invalid");
  }
  const foundOrder = await callTool(artifact, statusTool, {
    orderId: statusOrderId, requestedSize: "10", signerAddress: replaySigner.address, clobAuth,
  }, { fixtures: true, fixtureScenario: "order-status-found", expectedSignerAddress: replaySigner.address });
  if (foundOrder.structuredContent.status !== "PARTIALLY_FILLED" || foundOrder.structuredContent.filledSize !== "2"
    || foundOrder.structuredContent.remainingSize !== "8" || foundOrder.structuredContent.httpStatus !== 200) {
    fail("authenticated order record was not returned with its actual fill data", "clob_order_record_invalid");
  }
  const createdRead = await callTool(artifact, statusTool, { orderId: statusOrderId, requestedSize: "10", signerAddress: replaySigner.address, clobAuth },
    { fixtures: true, fixtureScenario: "order-status-created", expectedSignerAddress: replaySigner.address });
  if (createdRead.structuredContent.httpStatus !== 201) fail("SDK result reported an unobserved success HTTP status", "clob_order_record_invalid");
  const partialFakRemainder = await callTool(artifact, statusTool, {
    orderId: statusOrderId, requestedSize: "10", signerAddress: replaySigner.address, clobAuth,
  }, { fixtures: true, fixtureScenario: "order-status-fak-partial", expectedSignerAddress: replaySigner.address });
  if (partialFakRemainder.structuredContent.status !== "PARTIALLY_FILLED"
    || partialFakRemainder.structuredContent.orderType !== "FAK"
    || partialFakRemainder.structuredContent.filledSize !== "4"
    || partialFakRemainder.structuredContent.remainingSize !== "6"
    || !partialFakRemainder.structuredContent.message.includes("remainder does not rest")) {
    fail("FAK partial fill and CLOB-canceled remainder were not reconciled correctly", "clob_order_record_invalid");
  }
  const foundFokOrder = await callTool(artifact, statusTool, {
    orderId: statusOrderId, requestedSize: "10", signerAddress: replaySigner.address, clobAuth, orderType: "FOK",
  }, { fixtures: true, fixtureScenario: "order-status-fok-found", expectedSignerAddress: replaySigner.address });
  if (foundFokOrder.structuredContent.status !== "FILLED" || foundFokOrder.structuredContent.orderType !== "FOK"
    || foundFokOrder.structuredContent.filledSize !== "10") {
    fail("authoritative FOK order read-back did not preserve its full-fill result", "clob_order_record_invalid");
  }
  const identityMismatch = await callTool(artifact, statusTool, {
    orderId: statusOrderId, requestedSize: "10", signerAddress: depositPrepared.wallet.makerAddress, clobAuth: depositClobAuth,
  }, { fixtures: true, fixtureScenario: "identity-mismatch", expectedSignerAddress: depositPrepared.wallet.makerAddress });
  if (identityMismatch.structuredContent.errorCode !== "PS_AUTH_WALLET_MISMATCH") {
    fail("Deposit Wallet address was accepted as the owner EOA ClobAuth signer", "deposit_wallet_identity_invalid");
  }
  for (const [scenario, expectedCode, prepared, signature] of [
    ["snapshot-min-decrease", null, replayPrepared, orderSignature],
    ["snapshot-min-increase", "PS_SIZE_BELOW_MINIMUM", replayPrepared, orderSignature],
    ["snapshot-min-zero", "PS_PROVIDER_INVALID", replayPrepared, orderSignature],
    ["snapshot-tick-valid", null, replayPrepared, orderSignature],
    ["snapshot-risk-changed", "PS_MARKET_CHANGED", replayPrepared, orderSignature],
  ]) {
    const result = await callTool(artifact, submitTool, { preparedOrder: prepared, orderSignature: signature, clobAuth }, {
      fixtures: true, fixtureScenario: scenario,
    });
    if (expectedCode === null ? result.structuredContent.status !== "SUBMITTED" : result.structuredContent.errorCode !== expectedCode) {
      fail(`${scenario} did not apply current market constraints to the exact signed order`, "execution_snapshot_invalid");
    }
  }
  const offTickPreparedResponse = await callTool(artifact, prepareTool, {
    ...base, makerAddress: replaySigner.address, signingAddress: replaySigner.address,
    side: "BUY", priceLimit: "0.51", maxNominalPusd: "5.23",
  }, { fixtures: true });
  const offTickPrepared = offTickPreparedResponse.structuredContent.preparedOrder;
  const offTickSignature = await replaySigner.signTypedData(offTickPrepared.typedData);
  const offTickResult = await callTool(artifact, submitTool, {
    preparedOrder: offTickPrepared, orderSignature: offTickSignature, clobAuth,
  }, { fixtures: true, fixtureScenario: "snapshot-tick-invalid" });
  if (offTickResult.structuredContent.errorCode !== "PS_PRICE_INVALID") {
    fail(`signed price that violates the current tick size returned ${offTickResult.structuredContent.errorCode ?? offTickResult.structuredContent.status}`, "execution_snapshot_invalid");
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
  if (missingCredentials.structuredContent.errorCode !== "PS_CLOB_AUTH_REJECTED"
    || missingCredentials.structuredContent.httpStatus !== 401
    || JSON.stringify(missingCredentials.structuredContent).includes("SECRET_SENTINEL")) {
    fail("L1 credential rejection did not preserve safe HTTP status or exposed a provider body", "clob_auth_invalid");
  }
  const changedFee = await callTool(artifact, submitTool, submitArgs, { fixtures: true, fixtureScenario: "fee-changed" });
  if (changedFee.structuredContent.errorCode !== "PS_SPENDING_CAP") {
    fail("current fee increase was not bounded by the user-approved all-in spending cap", "spending_cap_invalid");
  }
  for (const [scenario, httpStatus] of [
    ["submit-ambiguous", 404], ["submit-ambiguous-429", 429], ["submit-ambiguous-503", 503],
    ["submit-malformed-success", 200], ["submit-malformed-order-id", 200],
  ]) {
    const ambiguous = await callTool(artifact, submitTool, submitArgs, { fixtures: true, fixtureScenario: scenario });
    if (ambiguous.structuredContent.status !== "UNKNOWN" || ambiguous.structuredContent.errorCode !== "PS_SUBMISSION_UNKNOWN"
      || ambiguous.structuredContent.httpStatus !== httpStatus || JSON.stringify(ambiguous.structuredContent).includes("SECRET_SENTINEL")) {
      fail(`${scenario} did not retain a sanitized unknown result and the single POST status`, "ambiguous_submit_invalid");
    }
  }
  const submissionReconciled = await callTool(artifact, submitTool, submitArgs, { fixtures: true, fixtureScenario: "submit-reconciled" });
  if (submissionReconciled.structuredContent.status !== "FILLED" || submissionReconciled.structuredContent.filledSize !== "10"
    || submissionReconciled.structuredContent.httpStatus !== 503) {
    fail("authoritative order read-back did not resolve an ambiguous POST while preserving the POST HTTP status", "ambiguous_submit_invalid");
  }
  for (const [scenario, errorCode, httpStatus] of [
    ["submit-l2-401", "PS_CLOB_PRIVATE_AUTH_REJECTED", 401],
    ["submit-400", "PS_CLOB_REJECTED", 400],
    ["submit-403", "PS_CLOB_FORBIDDEN", 403],
  ]) {
    const rejected = await callTool(artifact, submitTool, submitArgs, { fixtures: true, fixtureScenario: scenario });
    if (rejected.structuredContent.status !== "REJECTED" || rejected.structuredContent.errorCode !== errorCode
      || rejected.structuredContent.httpStatus !== httpStatus || JSON.stringify(rejected.structuredContent).includes("SECRET_SENTINEL")) {
      fail(`${scenario} did not retain its sanitized CLOB rejection classification`, "clob_submit_failure_invalid");
    }
  }
  if (!cancelTool) fail("cancel_order was not returned by tools/list", "tool_catalog_invalid");
  const cancelArgs = {
    orderId: statusOrderId, requestedSize: "10", signerAddress: replaySigner.address, clobAuth, confirmCancel: true,
  };
  const canceled = await callTool(artifact, cancelTool, cancelArgs, {
    fixtures: true, fixtureScenario: "cancel-valid", expectedSignerAddress: replaySigner.address,
  });
  if (canceled.structuredContent.status !== "CANCELLED" || canceled.structuredContent.httpStatus !== 200) {
    fail("confirmed cancellation did not return the structured CLOB result", "cancel_result_invalid");
  }
  for (const [scenario, errorCode, httpStatus] of [
    ["cancel-l1-401", "PS_CLOB_AUTH_REJECTED", 401],
    ["cancel-l2-401", "PS_CLOB_PRIVATE_AUTH_REJECTED", 401],
    ["cancel-403", "PS_CLOB_FORBIDDEN", 403],
  ]) {
    const rejected = await callTool(artifact, cancelTool, cancelArgs, {
      fixtures: true, fixtureScenario: scenario, expectedSignerAddress: replaySigner.address,
    });
    if (!["FAILED", "REJECTED"].includes(rejected.structuredContent.status)
      || rejected.structuredContent.errorCode !== errorCode || rejected.structuredContent.httpStatus !== httpStatus
      || JSON.stringify(rejected.structuredContent).includes("SECRET_SENTINEL")) {
      fail(`${scenario} did not return a schema-valid sanitized cancellation failure`, "cancel_result_invalid");
    }
  }
  const cancelUnknown = await callTool(artifact, cancelTool, cancelArgs, {
    fixtures: true, fixtureScenario: "cancel-ambiguous", expectedSignerAddress: replaySigner.address,
  });
  if (cancelUnknown.structuredContent.status !== "UNKNOWN" || cancelUnknown.structuredContent.errorCode !== "PS_CANCEL_UNKNOWN"
    || cancelUnknown.structuredContent.httpStatus !== 503) {
    fail("ambiguous cancellation did not preserve its single DELETE status and bounded read-back result", "cancel_result_invalid");
  }
  const cancelReconciled = await callTool(artifact, cancelTool, cancelArgs, {
    fixtures: true, fixtureScenario: "cancel-reconciled", expectedSignerAddress: replaySigner.address,
  });
  if (cancelReconciled.structuredContent.status !== "CANCELLED" || cancelReconciled.structuredContent.httpStatus !== 503) {
    fail("authoritative order read-back did not resolve an ambiguous cancellation", "cancel_result_invalid");
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
    || depositTypedData.message.verifyingContract.toLowerCase() !== (await fixtureWallet(fixtureSigner.address)).toLowerCase()
    || depositTypedData.message.contents.signatureType !== 3
    || deposit.structuredContent.preparedOrder.wallet.orderSignerAddress.toLowerCase() !== (await fixtureWallet(fixtureSigner.address)).toLowerCase()) {
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
    ["invalid-level", "PS_PROVIDER_INVALID"], ["provider-unavailable", "PS_PROVIDER_UNAVAILABLE"],
  ]) {
    const result = await callTool(artifact, prepareTool, { ...base, side: "BUY", priceLimit: "0.50" }, { fixtures: true, fixtureScenario: scenario });
    if (result.structuredContent.status !== "REJECTED" || result.structuredContent.errorCode !== errorCode
      || !result.structuredContent.reason || "preparedOrder" in result.structuredContent) {
      fail("known preparation failure did not return a distinguishable structured rejection", "preparation_rejection_invalid");
    }
  }
  for (const scenario of ["invalid-timestamp", "future-timestamp", "missing-book-timestamp"]) {
    const result = await callTool(artifact, prepareTool, { ...base, side: "BUY", priceLimit: "0.50" }, {
      fixtures: true, fixtureScenario: scenario,
    });
    if (result.structuredContent.status !== "PREPARED" || result.structuredContent.preparationFreshness.bookAgeMs !== null) {
      fail(`${scenario} book timestamp affected preparation instead of remaining informational`, "book_timestamp_invalid");
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
  const continuationInstruction = "These tools provide API evidence, not exhaustive research. When statistics, injuries, lineups or other relevant information are missing, continue with the host's web search/browser tools before writing the final analysis.";
  if (!newsTool?.description.includes(continuationInstruction)) fail("soccer-news browser continuation instruction is missing from the MCP tool definition", "tool_catalog_invalid");
  const news = await callTool(artifact, newsTool, { teams: ["Arsenal"], limit: 5 }, { fixtures: true });
  if (news.structuredContent.items.length !== 1 || news.structuredContent.items[0].matchedTeams[0] !== "Arsenal") {
    fail("soccer news included a headline unrelated to the requested team", "news_attribution_invalid");
  }
  const researchTool = tools.find((tool) => tool.name === "research_soccer");
  if (!researchTool?.description.includes(continuationInstruction)) fail("soccer-research browser continuation instruction is missing from the MCP tool definition", "tool_catalog_invalid");
  const soccerSkill = await readFile(resolve(root, "skills/polyscope-soccer-research/SKILL.md"), "utf8");
  for (const phrase of ["Form returned, xG missing", "Injury information missing", "Browser unavailable", "original URL", "manager statements", "head-to-head history"]) {
    if (!soccerSkill.includes(phrase)) fail(`soccer research skill is missing expected workflow guidance: ${phrase}`, "soccer_skill_invalid");
  }
  const edgeTool = tools.find((tool) => tool.name === "analyze_soccer_edge");
  if (!edgeTool) fail("analyze_soccer_edge was not returned by tools/list", "tool_catalog_invalid");
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
    if (fixture?.formCoverage !== "COMPLETE_LAST_5" || fixture.formReason !== null
      || fixture.homeFormResultCount !== 5 || fixture.awayFormResultCount !== 5
      || fixture.homeRecentResults.length !== 5 || fixture.awayRecentResults.length !== 5) {
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
  const enriched = await callTool(artifact, researchTool, {
    league: "PL", fixtureId: "1001", date: "2026-10-17", includeApiFootball: true,
  }, { fixtures: true });
  const enrichedFixture = enriched.structuredContent.fixtures[0];
  const apiFootball = enrichedFixture?.apiFootball;
  if (apiFootball?.availability !== "AVAILABLE" || apiFootball.matchIdentity?.providerFixtureId !== "90001"
    || apiFootball.matchIdentity.homeTeamProviderId !== "501" || enrichedFixture.homeTeamProviderId === "501"
    || apiFootball.homeStats?.playedAtHome !== 8 || apiFootball.awayStats?.playedAway !== 6
    || !apiFootball.sources.some((source) => source.purpose === "TEAM_STATISTICS" && new URL(source.url).searchParams.get("date") === "2026-10-16")) {
    fail("API-Football enrichment did not preserve independent IDs, source samples, and the pre-kickoff cutoff", "soccer_provider_invalid");
  }
  const enrichmentUrl = new URL(apiFootball.sources.find((source) => source.purpose === "MATCH_ENRICHMENT").url);
  if (enrichmentUrl.searchParams.get("league") !== "39" || enrichmentUrl.searchParams.get("season") !== "2026"
    || enrichmentUrl.searchParams.get("date") !== "2026-10-17" || enrichmentUrl.searchParams.get("timezone") !== "UTC") {
    fail("API-Football enrichment did not scope fixture lookup to the exact league, season, and UTC date", "soccer_provider_invalid");
  }
  const crossSeasonEnrichment = await callTool(artifact, researchTool, {
    league: "PL", fixtureId: "1001", date: "2026-01-17", includeApiFootball: true,
  }, { fixtures: true, fixtureScenario: "api-football-enrichment-cross-season" });
  const crossSeasonEnrichmentIdentity = crossSeasonEnrichment.structuredContent.fixtures[0]?.apiFootball?.matchIdentity;
  const crossSeasonEnrichmentUrl = new URL(crossSeasonEnrichment.structuredContent.fixtures[0]?.apiFootball?.sourceUrl);
  if (crossSeasonEnrichmentIdentity?.providerSeason !== 2025
    || crossSeasonEnrichmentUrl.searchParams.get("season") !== "2025"
    || crossSeasonEnrichmentUrl.searchParams.get("date") !== "2026-01-17") {
    fail("API-Football enrichment did not reuse the upstream season spanning a calendar-year boundary", "soccer_provider_invalid");
  }
  const missingSeason = await callTool(artifact, researchTool, {
    league: "PL", fixtureId: "1001", date: "2026-10-17", includeApiFootball: true,
  }, { fixtures: true, fixtureScenario: "api-football-season-missing" });
  const missingSeasonApi = missingSeason.structuredContent.fixtures[0]?.apiFootball;
  if (missingSeasonApi?.availability !== "AVAILABLE"
    || new URL(missingSeasonApi.sourceUrl).searchParams.get("season") !== "2026") {
    fail("missing upstream season dates did not use the unambiguous competition calendar", "soccer_provider_invalid");
  }
  const partialSeason = await callTool(artifact, researchTool, {
    league: "PL", fixtureId: "1001", date: "2026-01-17", includeApiFootball: true,
  }, { fixtures: true, fixtureScenario: "api-football-season-partial" });
  const partialSeasonApi = partialSeason.structuredContent.fixtures[0]?.apiFootball;
  if (partialSeasonApi?.availability !== "AVAILABLE"
    || partialSeasonApi.matchIdentity?.providerSeason !== 2025
    || new URL(partialSeasonApi.sourceUrl).searchParams.get("season") !== "2025") {
    fail("incomplete upstream season metadata did not use the consistent cross-year calendar season", "soccer_provider_invalid");
  }
  const quoteToolForAnalysis = tools.find((tool) => tool.name === "get_quote");
  const analysisQuote = await callTool(artifact, quoteToolForAnalysis, { marketId: "1", assetId: "123", side: "BUY", size: "10", depth: 10 }, { fixtures: true });
  const resolutionRules = "The market resolves to the named team winning the scheduled 90 minutes; extra time and penalties do not count.";
  const baselineForm = await callTool(artifact, researchTool, { league: "PL", fixtureId: "1001", date: "2026-10-17" }, { fixtures: true });
  const baselineModel = await callTool(artifact, edgeTool, {
    fixture: baselineForm.structuredContent.fixtures[0], quote: analysisQuote.structuredContent, outcome: "HOME_WIN",
    marketResolutionType: "REGULATION_1X2", marketResolutionRules: resolutionRules,
  }, { fixtures: true });
  if (baselineModel.structuredContent.probabilityStatus !== "AVAILABLE"
    || baselineModel.structuredContent.model.inputs.statisticsProvider !== "football-data.org"
    || baselineModel.structuredContent.model.inputs.homeMatchesAtHome !== 3
    || baselineModel.structuredContent.model.inputs.awayMatchesAway !== 2
    || baselineModel.structuredContent.model.sources.length !== 2) {
    fail("independent model did not use and attribute available pre-kickoff venue form when API-Football was not requested", "soccer_edge_invalid");
  }
  const fixedAnalysisNow = Date.parse("2026-10-17T04:23:29.396Z");
  const capturedQuote = { ...analysisQuote.structuredContent, observedAt: "2026-10-17T04:14:42.082Z",
    bookTimestamp: String(Date.parse("2026-10-17T04:14:42.082Z")), bookAgeMs: 0, freshness: "FRESH" };
  const agedAnalysis = await callTool(artifact, edgeTool, {
    fixture: baselineForm.structuredContent.fixtures[0], quote: capturedQuote, outcome: "HOME_WIN",
    marketResolutionType: "REGULATION_1X2", marketResolutionRules: resolutionRules,
  }, { fixtures: true, fixtureScenario: "analysis-fixed-clock" });
  if (agedAnalysis.structuredContent.quoteFreshnessAtCapture !== "FRESH"
    || agedAnalysis.structuredContent.quoteFreshness !== "STALE"
    || agedAnalysis.structuredContent.quoteAgeMsAtAnalysis !== fixedAnalysisNow - Date.parse("2026-10-17T04:14:42.082Z")
    || agedAnalysis.structuredContent.quoteBookTimestamp !== capturedQuote.bookTimestamp
    || !agedAnalysis.structuredContent.calculationAssumptions.some((item) => item.includes("historical edge estimate"))) {
    fail("analysis did not recalculate quote freshness or label the aged edge as historical", "soccer_quote_freshness_invalid");
  }
  for (const timestamp of [null, "not-a-timestamp", String(fixedAnalysisNow + 1_000)]) {
    const unknownAnalysis = await callTool(artifact, edgeTool, {
      fixture: baselineForm.structuredContent.fixtures[0], quote: { ...capturedQuote, bookTimestamp: timestamp }, outcome: "HOME_WIN",
      marketResolutionType: "REGULATION_1X2", marketResolutionRules: resolutionRules,
    }, { fixtures: true, fixtureScenario: "analysis-fixed-clock" });
    if (unknownAnalysis.structuredContent.quoteFreshness !== "UNKNOWN" || unknownAnalysis.structuredContent.quoteAgeMsAtAnalysis !== null) {
      fail("missing, invalid, or future book timestamps were not reported as unknown at analysis", "soccer_quote_freshness_invalid");
    }
  }
  const positiveEdge = await callTool(artifact, edgeTool, {
    fixture: enrichedFixture, quote: analysisQuote.structuredContent, outcome: "HOME_WIN",
    marketResolutionType: "REGULATION_1X2", marketResolutionRules: resolutionRules,
  }, { fixtures: true });
  const probabilities = positiveEdge.structuredContent.model;
  if (positiveEdge.structuredContent.probabilityStatus !== "AVAILABLE"
    || Math.abs((probabilities.homeWin + probabilities.draw + probabilities.awayWin) - 1) > 1e-12
    || probabilities.expectedHomeGoals !== 1.675 || probabilities.expectedAwayGoals !== 0.975
    || positiveEdge.structuredContent.edgeStatus !== "AVAILABLE"
    || positiveEdge.structuredContent.depthWeightedExecutionPrice !== analysisQuote.structuredContent.averagePrice
    || positiveEdge.structuredContent.effectiveBuyCostPerShare !== "0.5125") {
    fail("independent Poisson probabilities or fee-inclusive edge did not match deterministic inputs", "soccer_edge_invalid");
  }
  const favorableQuote = await callTool(artifact, quoteToolForAnalysis, { marketId: "1", assetId: "123", side: "BUY", size: "10", depth: 10 }, { fixtures: true, fixtureScenario: "analysis-favorable" });
  const positiveNetEdge = await callTool(artifact, edgeTool, {
    fixture: enrichedFixture, quote: favorableQuote.structuredContent, outcome: "HOME_WIN",
    marketResolutionType: "REGULATION_1X2", marketResolutionRules: resolutionRules,
  }, { fixtures: true });
  if (Number(positiveNetEdge.structuredContent.netEdgePerShare) <= 0) {
    fail("positive model-based edge was not represented as a positive numeric result", "soccer_edge_invalid");
  }
  const multilevelQuote = await callTool(artifact, quoteToolForAnalysis, { marketId: "1", assetId: "123", side: "BUY", size: "10", depth: 10 }, { fixtures: true, fixtureScenario: "analysis-multilevel" });
  const multilevelEdge = await callTool(artifact, edgeTool, {
    fixture: enrichedFixture, quote: multilevelQuote.structuredContent, outcome: "HOME_WIN",
    marketResolutionType: "REGULATION_1X2", marketResolutionRules: resolutionRules,
  }, { fixtures: true });
  if (multilevelQuote.structuredContent.bestAsk !== "0.5" || multilevelQuote.structuredContent.averagePrice !== "0.55"
    || multilevelEdge.structuredContent.depthWeightedExecutionPrice !== "0.55"
    || multilevelEdge.structuredContent.effectiveBuyCostPerShare !== "0.56225") {
    fail("edge calculation used the best ask or midpoint instead of fee-inclusive depth-weighted execution cost", "soccer_edge_invalid");
  }
  const negativeEdge = await callTool(artifact, edgeTool, {
    fixture: enrichedFixture, quote: analysisQuote.structuredContent, outcome: "AWAY_WIN",
    marketResolutionType: "REGULATION_1X2", marketResolutionRules: resolutionRules,
  }, { fixtures: true });
  if (negativeEdge.structuredContent.edgeStatus !== "AVAILABLE" || Number(negativeEdge.structuredContent.netEdgePerShare) >= 0) {
    fail("negative model-based edge was not represented as a numeric analysis result", "soccer_edge_invalid");
  }
  const partialQuote = await callTool(artifact, quoteToolForAnalysis, {
    marketId: "1", assetId: "123", side: "BUY", size: "10", depth: 10,
  }, { fixtures: true, fixtureScenario: "analysis-partial-depth" });
  const partialEdge = await callTool(artifact, edgeTool, {
    fixture: enrichedFixture, quote: partialQuote.structuredContent, outcome: "HOME_WIN",
    marketResolutionType: "REGULATION_1X2", marketResolutionRules: resolutionRules,
  }, { fixtures: true });
  if (partialEdge.structuredContent.edgeStatus !== "AVAILABLE" || partialEdge.structuredContent.fillableShares !== "4"
    || partialEdge.structuredContent.unfilledShares !== "6"
    || !partialEdge.structuredContent.model.uncertainty.some((item) => item.includes("partial fill"))) {
    fail("edge calculation did not limit expected value to visible partial FAK fillability", "soccer_edge_invalid");
  }
  const emptyQuote = await callTool(artifact, quoteToolForAnalysis, { marketId: "1", assetId: "123", side: "BUY", size: "10", depth: 10 }, { fixtures: true, fixtureScenario: "no-visible-liquidity" });
  const emptyEdge = await callTool(artifact, edgeTool, {
    fixture: enrichedFixture, quote: emptyQuote.structuredContent, outcome: "HOME_WIN",
    marketResolutionType: "REGULATION_1X2", marketResolutionRules: resolutionRules,
  }, { fixtures: true });
  if (emptyEdge.structuredContent.edgeStatus !== "UNAVAILABLE" || emptyEdge.structuredContent.netEdgePerShare !== null) {
    fail("edge calculation invented an executable price when the CLOB had no visible liquidity", "soccer_edge_invalid");
  }
  const sellQuote = await callTool(artifact, quoteToolForAnalysis, { marketId: "1", assetId: "123", side: "SELL", size: "10", depth: 10 }, { fixtures: true });
  const sellEdge = await callTool(artifact, edgeTool, {
    fixture: enrichedFixture, quote: sellQuote.structuredContent, outcome: "HOME_WIN",
    marketResolutionType: "REGULATION_1X2", marketResolutionRules: resolutionRules,
  }, { fixtures: true });
  if (sellEdge.structuredContent.edgeStatus !== "UNAVAILABLE" || !sellEdge.structuredContent.edgeReason?.includes("SELL edge is not calculated")) {
    fail("SELL edge was calculated without an existing position and sale-proceeds basis", "soccer_edge_invalid");
  }
  const unsupportedEdge = await callTool(artifact, edgeTool, {
    fixture: enrichedFixture, quote: analysisQuote.structuredContent, outcome: "HOME_WIN",
    marketResolutionType: "OTHER", marketResolutionRules: "The market resolves to qualify after possible extra time and penalties.",
  }, { fixtures: true });
  if (unsupportedEdge.structuredContent.edgeStatus !== "UNSUPPORTED_MARKET" || unsupportedEdge.structuredContent.netEdgePerShare !== null) {
    fail("unsupported market resolution was assigned a misleading edge", "soccer_edge_invalid");
  }
  const noProvider = await callTool(artifact, researchTool, {
    league: "PL", fixtureId: "1001", date: "2026-10-17", includeApiFootball: true,
  }, { fixtures: true, fixtureScenario: "api-football-403" });
  if (noProvider.structuredContent.availability !== "AVAILABLE" || noProvider.structuredContent.fixtures[0]?.apiFootball?.availability !== "UNAVAILABLE") {
    fail("API-Football authorization failure erased football-data.org baseline evidence", "soccer_provider_invalid");
  }
  const conflictingSeason = await callTool(artifact, researchTool, {
    league: "PL", fixtureId: "1001", date: "2026-10-17", includeApiFootball: true,
  }, { fixtures: true, fixtureScenario: "api-football-season-conflict" });
  if (conflictingSeason.structuredContent.fixtures[0]?.apiFootball?.availability !== "UNAVAILABLE"
    || !conflictingSeason.structuredContent.fixtures[0]?.apiFootball?.reason?.includes("invalid or conflicting")) {
    fail("conflicting upstream season metadata was guessed for API-Football enrichment", "soccer_provider_invalid");
  }
  const invalidSeason = await callTool(artifact, researchTool, {
    league: "PL", fixtureId: "1001", date: "2026-10-17", includeApiFootball: true,
  }, { fixtures: true, fixtureScenario: "api-football-season-invalid" });
  if (invalidSeason.structuredContent.fixtures[0]?.apiFootball?.availability !== "UNAVAILABLE"
    || !invalidSeason.structuredContent.fixtures[0]?.apiFootball?.reason?.includes("invalid or conflicting")) {
    fail("invalid upstream season metadata was guessed for API-Football enrichment", "soccer_provider_invalid");
  }
  const ambiguousSeason = await callTool(artifact, researchTool, {
    league: "PL", fixtureId: "1001", date: "2026-06-17", includeApiFootball: true,
  }, { fixtures: true, fixtureScenario: "api-football-season-ambiguous" });
  if (ambiguousSeason.structuredContent.fixtures[0]?.apiFootball?.availability !== "UNAVAILABLE"
    || !ambiguousSeason.structuredContent.fixtures[0]?.apiFootball?.reason?.includes("fixture date is ambiguous")) {
    fail("ambiguous competition calendar date was guessed for API-Football enrichment", "soccer_provider_invalid");
  }
  const fallbackIdentity = { homeTeam: "Arsenal", awayTeam: "Chelsea", kickoffUtc: "2026-10-17T19:00:00.000Z" };
  for (const [scenario, status] of [["fallback-http-401", 401], ["fallback-http-403", 403], ["fallback-http-429", 429], ["fallback-http-503", 503]]) {
    const fallback = await callTool(artifact, researchTool, { league: "PL", date: "2026-10-17", fixtureIdentity: fallbackIdentity }, { fixtures: true, fixtureScenario: scenario });
    if (fallback.structuredContent.fallbackProvider?.availability !== "AVAILABLE"
      || fallback.structuredContent.sources.find((source) => source.provider === "football-data.org")?.httpStatus !== status
      || fallback.structuredContent.fallbackFixtures?.[0]?.providerFixtureId !== "90001") {
      fail(`football-data.org HTTP ${status} did not preserve its diagnostic and return API-Football fallback evidence`, "soccer_fallback_invalid");
    }
  }
  for (const scenario of ["fallback-invalid-json", "fallback-invalid-shape", "fallback-network", "fallback-timeout"]) {
    const fallback = await callTool(artifact, researchTool, { league: "PL", date: "2026-10-17", fixtureIdentity: fallbackIdentity }, { fixtures: true, fixtureScenario: scenario });
    if (fallback.structuredContent.fallbackProvider?.availability !== "AVAILABLE"
      || fallback.structuredContent.sources.find((source) => source.provider === "football-data.org")?.availability !== "UNAVAILABLE") {
      fail(`${scenario} did not trigger a diagnostic API-Football fallback`, "soccer_fallback_invalid");
    }
  }
  const ordinarySuccess = await callTool(artifact, researchTool, { league: "PL", date: "2026-10-17" }, { fixtures: true, fixtureScenario: "no-unneeded-api" });
  if (ordinarySuccess.structuredContent.availability !== "AVAILABLE" || ordinarySuccess.structuredContent.fallbackProvider !== undefined
    || ordinarySuccess.structuredContent.resultProvider !== "football-data.org" || ordinarySuccess.structuredContent.provider !== "football-data.org") {
    fail("normal football-data.org success did not remain primary-only", "soccer_fallback_invalid");
  }
  const startDateFallback = await callTool(artifact, researchTool, { league: "PL", date: "2026-10-17", days: 0, fixtureIdentity: fallbackIdentity },
    { fixtures: true, fixtureScenario: "fallback-http-503" });
  const startDateCoverage = startDateFallback.structuredContent.fallbackProvider?.coverage;
  if (startDateFallback.structuredContent.availability !== "AVAILABLE" || startDateFallback.structuredContent.provider !== "football-data.org"
    || startDateFallback.structuredContent.resultProvider !== "API-Football" || startDateFallback.structuredContent.coverage !== "FALLBACK_MATCHES"
    || startDateCoverage?.requestedDateFrom !== "2026-10-17" || startDateCoverage?.requestedDateTo !== "2026-10-17"
    || startDateCoverage?.queriedDate !== "2026-10-17" || startDateCoverage?.datesNotQueried.length !== 0 || startDateCoverage?.status !== "COMPLETE") {
    fail("single-day API-Football fallback did not report complete date coverage and effective provider", "soccer_fallback_invalid");
  }
  const partialRangeFallback = await callTool(artifact, researchTool, { league: "PL", date: "2026-10-17", days: 7 },
    { fixtures: true, fixtureScenario: "fallback-http-503" });
  const partialRangeCoverage = partialRangeFallback.structuredContent.fallbackProvider?.coverage;
  if (partialRangeFallback.structuredContent.availability !== "AVAILABLE" || partialRangeFallback.structuredContent.resultProvider !== "API-Football"
    || partialRangeFallback.structuredContent.coverage !== "PARTIAL_FALLBACK_MATCHES" || partialRangeCoverage?.status !== "PARTIAL"
    || partialRangeCoverage?.requestedDateFrom !== "2026-10-17" || partialRangeCoverage?.requestedDateTo !== "2026-10-24"
    || partialRangeCoverage?.queriedDate !== "2026-10-17" || partialRangeCoverage?.datesNotQueried.length !== 7
    || !partialRangeCoverage?.continuationInstruction.includes("2026-10-24")) {
    fail("multi-day API-Football fallback implied full range coverage or omitted continuation guidance", "soccer_fallback_invalid");
  }
  const laterDateFixture = await callTool(artifact, researchTool, { league: "PL", date: "2026-10-17", days: 7 },
    { fixtures: true, fixtureScenario: "fallback-later-date" });
  const laterDateCoverage = laterDateFixture.structuredContent.fallbackProvider?.coverage;
  if (laterDateFixture.structuredContent.fallbackFixtures?.some((fixture) => fixture.providerFixtureId === "90024")
    || laterDateCoverage?.datesNotQueried.at(-1) !== "2026-10-24" || laterDateCoverage?.status !== "PARTIAL"
    || !laterDateCoverage.continuationInstruction.includes("2026-10-24")) {
    fail("later-date fixture omission was not represented as partial fallback coverage with continuation", "soccer_fallback_invalid");
  }
  const laterExactIdentity = { homeTeam: "Arsenal", awayTeam: "Chelsea", kickoffUtc: "2026-10-24T19:00:00.000Z" };
  const laterExactFallback = await callTool(artifact, researchTool, { league: "PL", date: "2026-10-17", days: 7, fixtureIdentity: laterExactIdentity },
    { fixtures: true, fixtureScenario: "fallback-later-date" });
  if (laterExactFallback.structuredContent.fallbackFixtures?.[0]?.providerFixtureId !== "90024"
    || laterExactFallback.structuredContent.fallbackFixtures[0]?.kickoffUtc !== laterExactIdentity.kickoffUtc
    || laterExactFallback.structuredContent.fallbackProvider?.coverage.status !== "PARTIAL") {
    fail("exact identity on a later in-range date was not matched while retaining partial range coverage", "soccer_fallback_invalid");
  }
  const outOfRangeIdentity = await runOperation(artifact, {
    method: "tools/call", params: { name: researchTool.name, arguments: {
      league: "PL", date: "2026-10-17", days: 7,
      fixtureIdentity: { ...laterExactIdentity, kickoffUtc: "2026-10-25T19:00:00.000Z" },
    } },
  }, { fixtures: true, fixtureScenario: "fallback-range-conflict" });
  if (outOfRangeIdentity.result?.isError !== true
    || !JSON.stringify(outOfRangeIdentity.result.content).includes("PS_FIXTURE_IDENTITY_DATE_OUT_OF_RANGE")) {
    fail("out-of-range fixture identity did not fail before provider research", "soccer_fallback_invalid");
  }
  const emptyPrimary = await callTool(artifact, researchTool, { league: "PL", date: "2026-10-17" }, { fixtures: true, fixtureScenario: "fallback-empty" });
  if (emptyPrimary.structuredContent.fallbackProvider !== undefined || emptyPrimary.structuredContent.fallbackFixtures !== undefined) {
    fail("valid empty football-data.org results incorrectly triggered API-Football fallback", "soccer_fallback_invalid");
  }
  const fallbackFailure = await callTool(artifact, researchTool, { league: "PL", date: "2026-10-17" }, { fixtures: true, fixtureScenario: "fallback-api-403" });
  if (fallbackFailure.structuredContent.fallbackProvider?.availability !== "UNAVAILABLE"
    || !fallbackFailure.structuredContent.fallbackProvider.reason?.includes("HTTP 403")
    || fallbackFailure.structuredContent.sources[0]?.httpStatus !== 503
    || fallbackFailure.structuredContent.sources[1]?.httpStatus !== 403) {
    fail("API-Football fallback failure was not retained as a separate provider diagnostic", "soccer_fallback_invalid");
  }
  for (const [scenario, reason] of [["fallback-api-204", "HTTP 204"], ["fallback-api-invalid-json", "invalid JSON"],
    ["fallback-api-invalid-shape", "unexpected fixtures response shape"], ["fallback-api-empty", "no fixtures"], ["fallback-api-error", "endpoint error"]]) {
    const fallback = await callTool(artifact, researchTool, { league: "PL", date: "2026-10-17" }, { fixtures: true, fixtureScenario: scenario });
    if (fallback.structuredContent.fallbackProvider?.availability !== "UNAVAILABLE"
      || !fallback.structuredContent.fallbackProvider.reason?.includes(reason)) {
      fail(`${scenario} fallback failure was not reported accurately`, "soccer_fallback_invalid");
    }
  }
  const exactFallback = await callTool(artifact, researchTool, {
    league: "PL", fixtureId: "1001", date: "2026-10-17", fixtureIdentity: fallbackIdentity,
  }, { fixtures: true, fixtureScenario: "fallback-exact-failure" });
  const exactFallbackFixture = exactFallback.structuredContent.fallbackFixtures?.[0];
  if (exactFallbackFixture?.provider !== "API-Football" || exactFallbackFixture.providerFixtureId !== "90001"
    || exactFallbackFixture.verificationStatus !== "PARTIAL" || exactFallbackFixture.providerHomeTeamId !== "501" || exactFallbackFixture.homeStats?.providerTeamId !== "501"
    || "fixtureId" in exactFallbackFixture || "homeTeamProviderId" in exactFallbackFixture) {
    fail("exact fallback did not preserve namespaced IDs and single-provider verification status", "soccer_fallback_invalid");
  }
  if (exactFallbackFixture?.sourceUrl !== "https://v3.football.api-sports.io/fixtures?league=39&season=2026&date=2026-10-17&timezone=UTC"
    || !exactFallbackFixture.observedAt || exactFallbackFixture.statisticsAvailability !== "AVAILABLE"
    || exactFallbackFixture.sources.length !== 3) {
    fail("API-Football fallback did not preserve fixture/statistics source provenance", "soccer_fallback_invalid");
  }
  const crossSeasonFallback = await callTool(artifact, researchTool, {
    league: "PL", date: "2026-01-17", fixtureIdentity: { homeTeam: "Arsenal", awayTeam: "Chelsea", kickoffUtc: "2026-01-17T19:00:00.000Z" },
  }, { fixtures: true, fixtureScenario: "fallback-cross-season" });
  if (crossSeasonFallback.structuredContent.fallbackFixtures?.[0]?.providerSeason !== 2025
    || new URL(crossSeasonFallback.structuredContent.fallbackProvider.sourceUrl).searchParams.get("season") !== "2025") {
    fail("API-Football fallback did not use the season start year for a cross-calendar-year fixture", "soccer_fallback_invalid");
  }
  const unknownSeasonFallback = await callTool(artifact, researchTool, { league: "PL", date: "2026-06-17" },
    { fixtures: true, fixtureScenario: "fallback-season-unknown" });
  if (!unknownSeasonFallback.structuredContent.fallbackProvider.reason?.includes("was not requested")
    || !unknownSeasonFallback.structuredContent.fallbackProvider.reason?.includes("could not be established safely")) {
    fail("ambiguous competition season did not produce an explicit no-request diagnostic", "soccer_fallback_invalid");
  }
  for (const scenario of ["fallback-api-wrong-league", "fallback-api-wrong-season", "fallback-api-oversized"]) {
    const result = await callTool(artifact, researchTool, {
      league: "PL", date: "2026-10-17", fixtureIdentity: fallbackIdentity,
    }, { fixtures: true, fixtureScenario: scenario });
    if (result.structuredContent.fallbackFixtures?.length !== 0 || result.structuredContent.fallbackProvider?.availability !== "UNAVAILABLE") {
      fail(`${scenario} was accepted as a matching fallback fixture`, "soccer_fallback_invalid");
    }
    if (scenario === "fallback-api-oversized" && !result.structuredContent.fallbackProvider.reason?.includes("exceeded the 1 MB limit")) {
      fail("oversized API-Football fallback response did not retain the 1 MB diagnostic", "soccer_fallback_invalid");
    }
  }
  const fallbackCompetitionFixtures = {
    PL: { homeTeam: "Arsenal", awayTeam: "Chelsea", providerFixtureId: "90001" },
    PD: { homeTeam: "Real Madrid", awayTeam: "Barcelona", providerFixtureId: "90002" },
    SA: { homeTeam: "Inter", awayTeam: "Milan", providerFixtureId: "90003" },
    CL: { homeTeam: "Paris Saint-Germain", awayTeam: "Bayern Munich", providerFixtureId: "90004" },
  };
  for (const [league, identity] of Object.entries(fallbackCompetitionFixtures)) {
    const fallback = await callTool(artifact, researchTool, {
      league, date: "2026-10-17", fixtureIdentity: { homeTeam: identity.homeTeam, awayTeam: identity.awayTeam, kickoffUtc: "2026-10-17T19:00:00.000Z" },
    }, { fixtures: true, fixtureScenario: "fallback-http-503" });
    if (fallback.structuredContent.fallbackFixtures?.length !== 1
      || fallback.structuredContent.fallbackFixtures[0]?.providerFixtureId !== identity.providerFixtureId) {
      fail(`${league} API-Football fallback did not match its own competition and fixture identity`, "soccer_fallback_invalid");
    }
    const query = new URL(fallback.structuredContent.fallbackProvider.sourceUrl).searchParams;
    if (query.get("league") !== ({ PL: "39", PD: "140", SA: "135", CL: "2" })[league]
      || query.get("season") !== "2026" || query.get("date") !== "2026-10-17" || query.get("timezone") !== "UTC") {
      fail(`${league} API-Football request did not use its competition-specific season-scoped endpoint`, "soccer_fallback_invalid");
    }
  }
  const incompleteStatsFallback = await callTool(artifact, researchTool, {
    league: "PL", fixtureId: "1001", date: "2026-10-17", fixtureIdentity: fallbackIdentity,
  }, { fixtures: true, fixtureScenario: "fallback-api-stats-403" });
  if (incompleteStatsFallback.structuredContent.fallbackFixtures?.[0]?.providerFixtureId !== "90001"
    || incompleteStatsFallback.structuredContent.fallbackFixtures?.[0]?.statisticsAvailability !== "UNAVAILABLE"
    || !incompleteStatsFallback.structuredContent.fallbackFixtures?.[0]?.statisticsReason?.includes("HTTP 403")) {
    fail("missing API-Football statistics erased fixture evidence or its provider error", "soccer_fallback_invalid");
  }
  const noIdentityFallback = await callTool(artifact, researchTool, {
    league: "PL", fixtureId: "1001", date: "2026-10-17",
  }, { fixtures: true, fixtureScenario: "fallback-exact-failure" });
  if (noIdentityFallback.structuredContent.fallbackFixtures?.some((fixture) => fixture.verificationStatus === "VERIFIED" || fixture.homeStats !== null)
    || noIdentityFallback.structuredContent.fallbackProvider?.verificationStatus !== "UNVERIFIED") {
    fail("football-data.org numeric fixture ID was guessed as an API-Football match", "soccer_fallback_invalid");
  }
  const ambiguousFallback = await callTool(artifact, researchTool, {
    league: "PL", date: "2026-10-17", fixtureIdentity: fallbackIdentity,
  }, { fixtures: true, fixtureScenario: "fallback-ambiguous" });
  if (ambiguousFallback.structuredContent.fallbackProvider?.verificationStatus !== "CONFLICTED"
    || ambiguousFallback.structuredContent.fallbackFixtures?.length !== 0) {
    fail("ambiguous API-Football fixtures were accepted as an exact match", "soccer_fallback_invalid");
  }
  const kickoffConflictFallback = await callTool(artifact, researchTool, {
    league: "PL", date: "2026-10-17", fixtureIdentity: fallbackIdentity,
  }, { fixtures: true, fixtureScenario: "fallback-kickoff-conflict" });
  if (kickoffConflictFallback.structuredContent.fallbackFixtures?.length !== 0
    || kickoffConflictFallback.structuredContent.fallbackProvider?.verificationStatus !== "UNVERIFIED"
    || !kickoffConflictFallback.structuredContent.fallbackProvider.reason?.includes("exact UTC kickoff")) {
    fail("conflicting API-Football kickoff was accepted as the requested exact fixture", "soccer_fallback_invalid");
  }
  const fallbackQuote = await callTool(artifact, quoteToolForAnalysis, { marketId: "1", assetId: "123", side: "BUY", size: "10", depth: 10 }, { fixtures: true });
  const fallbackFixtureForAnalysis = exactFallback.structuredContent.fallbackFixtures[0];
  const unverifiedFallbackModel = await callTool(artifact, edgeTool, {
    fixture: fallbackFixtureForAnalysis, quote: fallbackQuote.structuredContent, outcome: "HOME_WIN",
    marketResolutionType: "REGULATION_1X2", marketResolutionRules: resolutionRules,
  }, { fixtures: true });
  if (unverifiedFallbackModel.structuredContent.probabilityStatus !== "UNAVAILABLE"
    || unverifiedFallbackModel.structuredContent.model.homeWin !== null
    || unverifiedFallbackModel.structuredContent.edgeStatus !== "UNAVAILABLE"
    || unverifiedFallbackModel.structuredContent.netEdgePerShare !== null
    || unverifiedFallbackModel.structuredContent.estimatedExpectedValuePusd !== null
    || unverifiedFallbackModel.structuredContent.evidenceAssessment?.claimAuthority !== "HOST_AGENT"
    || unverifiedFallbackModel.structuredContent.evidenceAssessment?.identityClaimMatchesFixture !== false
    || unverifiedFallbackModel.structuredContent.evidenceAssessment?.sourceVerification !== "NOT_PERFORMED_BY_POLYSCOPE") {
    fail("API-Football-only identity without independent verification produced probabilities or edge", "soccer_edge_invalid");
  }
  const identityEvidence = [{ provider: "Official competition fixture page", url: "https://competition.example.test/fixtures/arsenal-chelsea",
    observedAt: "2026-10-17T12:00:00.000Z", publishedAt: null, verificationStatus: "VERIFIED", confidenceCategory: "MODERATE",
    confidenceReason: "The official competition page independently names both teams and the UTC kickoff.", competition: "Premier League",
    homeTeam: "Arsenal", awayTeam: "Chelsea", kickoffUtc: "2026-10-17T19:00:00.000Z" }];
  const marketMapping = { provider: "Polymarket Gamma", url: "https://gamma-api.polymarket.com/markets/1",
    observedAt: fallbackQuote.structuredContent.observedAt, marketId: fallbackQuote.structuredContent.marketId,
    question: fallbackQuote.structuredContent.question, outcome: fallbackQuote.structuredContent.outcome,
    competition: "Premier League", homeTeam: "Arsenal FC", awayTeam: "Chelsea", kickoffUtc: "2026-10-17T19:00:00.000Z",
    outcomeMapping: "HOME_WIN", resolutionType: "REGULATION_1X2", resolutionRules };
  const verifiedFallbackModel = await callTool(artifact, edgeTool, {
    fixture: fallbackFixtureForAnalysis, quote: fallbackQuote.structuredContent, outcome: "HOME_WIN",
    marketResolutionType: "REGULATION_1X2", marketResolutionRules: resolutionRules, identityEvidence, marketMapping,
  }, { fixtures: true });
  if (verifiedFallbackModel.structuredContent.probabilityStatus !== "AVAILABLE"
    || verifiedFallbackModel.structuredContent.edgeStatus !== "AVAILABLE"
    || verifiedFallbackModel.structuredContent.evidenceAssessment?.claimAuthority !== "HOST_AGENT"
    || verifiedFallbackModel.structuredContent.evidenceAssessment?.sourceVerification !== "NOT_PERFORMED_BY_POLYSCOPE"
    || verifiedFallbackModel.structuredContent.evidenceAssessment?.identityClaimMatchesFixture !== true
    || verifiedFallbackModel.structuredContent.evidenceAssessment?.marketClaimMatchesSuppliedQuoteAndFixture !== true
    || verifiedFallbackModel.structuredContent.identityEvidence?.[0]?.attestationAuthority !== "HOST_AGENT"
    || verifiedFallbackModel.structuredContent.marketMapping?.attestationAuthority !== "HOST_AGENT"
    || verifiedFallbackModel.structuredContent.identityEvidence?.[0]?.publishedAt !== null
    || verifiedFallbackModel.structuredContent.model.sources.some((source) => source.provider === "Official competition fixture page")) {
    fail("host-attested fallback evidence was presented as PolyScope source verification or model statistics", "soccer_edge_invalid");
  }
  if (verifiedFallbackModel.structuredContent.identityEvidence?.[0]?.url !== "https://competition.example.test/fixtures/arsenal-chelsea") {
    fail("fabricated identity URL was not preserved as a host-attested claim", "soccer_edge_invalid");
  }
  const mismappedFallbackModel = await callTool(artifact, edgeTool, {
    fixture: fallbackFixtureForAnalysis, quote: fallbackQuote.structuredContent, outcome: "HOME_WIN",
    marketResolutionType: "REGULATION_1X2", marketResolutionRules: resolutionRules, identityEvidence,
    marketMapping: { ...marketMapping, marketId: "2" },
  }, { fixtures: true });
  if (mismappedFallbackModel.structuredContent.probabilityStatus !== "AVAILABLE"
    || mismappedFallbackModel.structuredContent.edgeStatus !== "UNAVAILABLE"
    || mismappedFallbackModel.structuredContent.netEdgePerShare !== null
    || mismappedFallbackModel.structuredContent.evidenceAssessment?.marketClaimMatchesSuppliedQuoteAndFixture !== false) {
    fail("market identity mismatch produced a market-specific edge", "soccer_edge_invalid");
  }
  const apiOnlyIdentityEvidence = [{ ...identityEvidence[0], provider: "API-Football" }];
  const sameProviderVerification = await callTool(artifact, edgeTool, {
    fixture: fallbackFixtureForAnalysis, quote: fallbackQuote.structuredContent, outcome: "HOME_WIN",
    marketResolutionType: "REGULATION_1X2", marketResolutionRules: resolutionRules,
    identityEvidence: apiOnlyIdentityEvidence, marketMapping,
  }, { fixtures: true });
  if (sameProviderVerification.structuredContent.probabilityStatus !== "UNAVAILABLE"
    || sameProviderVerification.structuredContent.edgeStatus !== "UNAVAILABLE") {
    fail("API-Football evidence was incorrectly treated as independent fixture corroboration", "soccer_edge_invalid");
  }
  const missingStatsFixture = incompleteStatsFallback.structuredContent.fallbackFixtures[0];
  const missingStatsModel = await callTool(artifact, edgeTool, {
    fixture: missingStatsFixture, quote: fallbackQuote.structuredContent, outcome: "HOME_WIN",
    marketResolutionType: "REGULATION_1X2", marketResolutionRules: resolutionRules, identityEvidence, marketMapping,
  }, { fixtures: true });
  if (missingStatsModel.structuredContent.probabilityStatus !== "UNAVAILABLE"
    || missingStatsModel.structuredContent.model.homeWin !== null || missingStatsModel.structuredContent.edgeStatus !== "UNAVAILABLE"
    || missingStatsModel.structuredContent.netEdgePerShare !== null || missingStatsModel.structuredContent.estimatedExpectedValuePusd !== null) {
    fail("missing fallback venue statistics produced fabricated probability or edge values", "soccer_edge_invalid");
  }
  const ambiguousProvider = await callTool(artifact, researchTool, {
    league: "PL", fixtureId: "1001", date: "2026-10-17", includeApiFootball: true,
  }, { fixtures: true, fixtureScenario: "api-football-ambiguous" });
  if (ambiguousProvider.structuredContent.fixtures[0]?.apiFootball?.availability !== "UNAVAILABLE"
    || !ambiguousProvider.structuredContent.fixtures[0]?.apiFootball?.reason?.includes("multiple fixtures")) {
    fail("ambiguous cross-provider fixture matches were silently joined", "soccer_provider_invalid");
  }
  const mismatchProvider = await callTool(artifact, researchTool, {
    league: "PL", fixtureId: "1001", date: "2026-10-17", includeApiFootball: true,
  }, { fixtures: true, fixtureScenario: "api-football-mismatch" });
  if (mismatchProvider.structuredContent.fixtures[0]?.apiFootball?.availability !== "UNAVAILABLE") {
    fail("nonmatching provider fixture was accepted as an enrichment", "soccer_provider_invalid");
  }
  const providerApiError = await callTool(artifact, researchTool, {
    league: "PL", fixtureId: "1001", date: "2026-10-17", includeApiFootball: true,
  }, { fixtures: true, fixtureScenario: "api-football-api-error" });
  if (providerApiError.structuredContent.availability !== "AVAILABLE"
    || !providerApiError.structuredContent.fixtures[0]?.apiFootball?.reason?.includes("endpoint error")) {
    fail("API-Football's HTTP 200 error envelope was reported as a valid empty fixture set", "soccer_provider_invalid");
  }
  const providerNoContent = await callTool(artifact, researchTool, {
    league: "PL", fixtureId: "1001", date: "2026-10-17", includeApiFootball: true,
  }, { fixtures: true, fixtureScenario: "api-football-204" });
  if (providerNoContent.structuredContent.availability !== "AVAILABLE"
    || !providerNoContent.structuredContent.fixtures[0]?.apiFootball?.reason?.includes("HTTP 204")) {
    fail("API-Football HTTP 204 was conflated with an authentication failure", "soccer_provider_invalid");
  }
  const kickoffConflict = await callTool(artifact, researchTool, {
    league: "PL", fixtureId: "1001", date: "2026-10-17", includeApiFootball: true,
  }, { fixtures: true, fixtureScenario: "api-football-kickoff-conflict" });
  if (kickoffConflict.structuredContent.availability !== "AVAILABLE"
    || kickoffConflict.structuredContent.fixtures[0]?.apiFootball?.availability !== "UNAVAILABLE") {
    fail("conflicting cross-provider kickoff times were silently joined", "soccer_provider_invalid");
  }
  const unavailableStats = await callTool(artifact, researchTool, {
    league: "PL", fixtureId: "1001", date: "2026-10-17", includeApiFootball: true,
  }, { fixtures: true, fixtureScenario: "api-football-stats-403" });
  if (unavailableStats.structuredContent.availability !== "AVAILABLE"
    || unavailableStats.structuredContent.fixtures[0]?.apiFootball?.availability !== "UNAVAILABLE"
    || unavailableStats.structuredContent.fixtures[0]?.apiFootball?.matchIdentity?.providerFixtureId !== "90001") {
    fail("API-Football statistics failure discarded the matched fixture or baseline research", "soccer_provider_invalid");
  }
  const emptyStats = await callTool(artifact, researchTool, {
    league: "PL", fixtureId: "1001", date: "2026-10-17", includeApiFootball: true,
  }, { fixtures: true, fixtureScenario: "api-football-empty-stats" });
  if (emptyStats.structuredContent.availability !== "AVAILABLE"
    || emptyStats.structuredContent.fixtures[0]?.apiFootball?.availability !== "UNAVAILABLE"
    || !emptyStats.structuredContent.fixtures[0]?.apiFootball?.reason?.includes("positive venue sample counts")) {
    fail("missing API-Football venue statistics were presented as usable research", "soccer_provider_invalid");
  }
  const unavailableModel = await callTool(artifact, edgeTool, {
    fixture: unavailableStats.structuredContent.fixtures[0], quote: analysisQuote.structuredContent, outcome: "HOME_WIN",
    marketResolutionType: "REGULATION_1X2", marketResolutionRules: resolutionRules,
  }, { fixtures: true });
  if (unavailableModel.structuredContent.probabilityStatus !== "AVAILABLE"
    || unavailableModel.structuredContent.model.inputs.statisticsProvider !== "football-data.org") {
    fail("baseline venue form was not used when optional API-Football statistics failed", "soccer_edge_invalid");
  }
  const noHistory = await callTool(artifact, researchTool, { league: "PL", fixtureId: "7776", date: "2026-10-20" }, { fixtures: true });
  const unavailableModelResult = await callTool(artifact, edgeTool, {
    fixture: noHistory.structuredContent.fixtures[0], quote: analysisQuote.structuredContent, outcome: "HOME_WIN",
    marketResolutionType: "REGULATION_1X2", marketResolutionRules: resolutionRules,
  }, { fixtures: true });
  if (unavailableModelResult.structuredContent.probabilityStatus !== "UNAVAILABLE"
    || unavailableModelResult.structuredContent.model.homeWin !== null
    || unavailableModelResult.structuredContent.edgeStatus !== "UNAVAILABLE") {
    fail("missing all statistical inputs generated a probability or edge", "soccer_edge_invalid");
  }
  const mixedCompetitionForm = await callTool(artifact, researchTool, { league: "PL", fixtureId: "560611", date: "2026-10-17", days: 0, limit: 3 }, { fixtures: true });
  const mixedFixture = mixedCompetitionForm.structuredContent.fixtures[0];
  const brentfordSource = mixedCompetitionForm.structuredContent.sources.find((source) => source.purpose === "TEAM_FORM" && source.teamProviderId === "402");
  const liverpoolSource = mixedCompetitionForm.structuredContent.sources.find((source) => source.purpose === "TEAM_FORM" && source.teamProviderId === "64");
  if (mixedFixture?.formCoverage !== "PARTIAL" || mixedFixture.homeFormResultCount !== 5
    || mixedFixture.awayFormResultCount !== 0 || !mixedFixture.formReason?.includes("Liverpool FC (0/5 results)")
    || !mixedFixture.formReason.includes("HTTP 403") || brentfordSource?.teamName !== "Brentford FC"
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
  if (incompleteForm.structuredContent.fixtures[0]?.formCoverage !== "PARTIAL"
    || incompleteForm.structuredContent.fixtures[0]?.homeFormCoverage !== "PARTIAL"
    || incompleteForm.structuredContent.fixtures[0]?.homeFormResultCount !== 4
    || incompleteForm.structuredContent.fixtures[0]?.homeRecentResults.length !== 4
    || !incompleteForm.structuredContent.fixtures[0]?.formReason?.includes("4/5 results")) {
    fail("partial historical soccer form was not returned with its actual count", "soccer_form_invalid");
  }
  const fiveFourForm = await callTool(artifact, researchTool, { league: "PL", fixtureId: "7777", date: "2026-10-20", days: 0, limit: 3 }, { fixtures: true });
  const fiveFourFixture = fiveFourForm.structuredContent.fixtures[0];
  if (fiveFourFixture?.formCoverage !== "PARTIAL" || fiveFourFixture.homeFormResultCount !== 5
    || fiveFourFixture.awayFormResultCount !== 4 || fiveFourFixture.homeRecentResults.length !== 5
    || fiveFourFixture.awayRecentResults.length !== 4 || !fiveFourFixture.formReason?.includes("Partial History FC (4/5 results)")) {
    fail("5/4 team form did not retain both teams' available results and explain partial coverage", "soccer_form_invalid");
  }
  const zeroZeroForm = await callTool(artifact, researchTool, { league: "PL", fixtureId: "7776", date: "2026-10-20", days: 0, limit: 3 }, { fixtures: true });
  const zeroZeroFixture = zeroZeroForm.structuredContent.fixtures[0];
  if (zeroZeroFixture?.formCoverage !== "UNAVAILABLE" || zeroZeroFixture.homeFormResultCount !== 0
    || zeroZeroFixture.awayFormResultCount !== 0 || !zeroZeroFixture.formReason?.startsWith("Form unavailable:")) {
    fail("0/0 team form did not report unavailable coverage", "soccer_form_invalid");
  }
  const deniedForm = await callTool(artifact, researchTool, { league: "PL", fixtureId: "8888", date: "2026-10-21", days: 0, limit: 3 }, { fixtures: true });
  const deniedReason = deniedForm.structuredContent.sources.find((source) => source.purpose === "TEAM_FORM" && source.teamProviderId === "888")?.reason ?? "";
  if (!deniedReason.includes("HTTP 403") || !deniedReason.toLowerCase().includes("permission") || deniedReason.includes("sensitive provider detail")) {
    fail("team-form permission failures did not expose a safe HTTP status", "soccer_provider_error_invalid");
  }
  const rateLimitedForm = await callTool(artifact, researchTool, { league: "SA", fixtureId: "8889", date: "2026-10-22", days: 0, limit: 3 }, { fixtures: true });
  const rateLimitReason = rateLimitedForm.structuredContent.sources.find((source) => source.purpose === "TEAM_FORM" && source.teamProviderId === "889")?.reason ?? "";
  const rateLimitedFixture = rateLimitedForm.structuredContent.fixtures[0];
  if (!rateLimitReason.includes("HTTP 429") || rateLimitedFixture?.formCoverage !== "PARTIAL"
    || rateLimitedFixture.homeFormResultCount !== 0 || rateLimitedFixture.awayFormResultCount !== 5
    || !rateLimitedFixture.formReason?.includes("HTTP 429")) {
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
  const redeemableToolDescription = tools.find((tool) => tool.name === "get_portfolio")?.description ?? "";
  const redeemablePortfolio = await callTool(artifact, portfolioTool, { walletAddress: "0x0000000000000000000000000000000000000001", limit: 10 },
    { fixtures: true, fixtureScenario: "portfolio-redeemable" });
  if (!redeemableToolDescription.includes("OPEN may include held REDEEMABLE positions")
    || new URL(redeemablePortfolio.structuredContent.sourceUrl).searchParams.get("status") !== "OPEN"
    || redeemablePortfolio.structuredContent.positions[0]?.status !== "REDEEMABLE"
    || redeemablePortfolio.structuredContent.positions[0]?.redeemable !== true
    || redeemablePortfolio.structuredContent.hasMore !== true
    || redeemablePortfolio.structuredContent.nextCursor !== "fixture-next-page") {
    fail("OPEN portfolio filtering dropped or misrepresented a redeemable position or its pagination", "portfolio_status_invalid");
  }
  const portfolioNextPage = await callTool(artifact, portfolioTool, {
    walletAddress: "0x0000000000000000000000000000000000000001", limit: 10, cursor: portfolio.structuredContent.nextCursor,
  }, { fixtures: true });
  if (portfolioNextPage.structuredContent.positions.length !== 1 || portfolioNextPage.structuredContent.complete !== true
    || portfolioNextPage.structuredContent.hasMore !== false || portfolioNextPage.structuredContent.nextCursor !== null) {
    fail("portfolio did not mark the final v2 cursor page complete", "portfolio_pagination_invalid");
  }
  const readinessTool = tools.find((tool) => tool.name === "get_trading_readiness");
  const redeemTool = tools.find((tool) => tool.name === "prepare_redeem");
  if (!readinessTool || !redeemTool) fail("read-only trading readiness and redemption preview tools were not returned", "tool_catalog_invalid");
  if (readinessTool.annotations?.readOnlyHint !== true || redeemTool.annotations?.readOnlyHint !== true) {
    fail("trading readiness and redemption preview must remain read-only", "tool_catalog_invalid");
  }
  const accountWallet = fixtureSigner.address;
  const conditionId = `0x${"1".repeat(64)}`;
  for (const scenario of ["readiness-no-context", "readiness-buy", "readiness-neg-risk", "readiness-v2", "readiness-sdkEmpty"]) {
    const result = await callTool(artifact, readinessTool, { walletAddress: accountWallet, walletType: "EOA", marketId: "1", side: "BUY" }, { fixtures: true, fixtureScenario: scenario });
    if (result.structuredContent.status !== "UNKNOWN" || result.structuredContent.approval.status !== "PRESENT"
      || result.structuredContent.pUsdBalance.status !== "UNKNOWN" || result.structuredContent.polBalance !== null
      || result.structuredContent.approval.target !== null || result.structuredContent.eoaTradingEligibility !== "UNKNOWN") {
      fail("SDK approval summary claimed funding, per-market routing, or EOA eligibility", "trading_readiness_invalid");
    }
  }
  const sdkMissing = await callTool(artifact, readinessTool, { walletAddress: accountWallet, walletType: "EOA" }, { fixtures: true, fixtureScenario: "readiness-sell-missing" });
  if (sdkMissing.structuredContent.status !== "ACTION_REQUIRED" || sdkMissing.structuredContent.approval.status !== "MISSING") fail("SDK sdkMissing approvals were not reported", "trading_readiness_invalid");
  const sdkUnavailable = await callTool(artifact, readinessTool, { walletAddress: accountWallet, walletType: "EOA" }, { fixtures: true, fixtureScenario: "chain-read-unavailable" });
  if (sdkUnavailable.structuredContent.approval.status !== "UNKNOWN") fail("sdkUnavailable SDK approvals were treated as present", "trading_readiness_invalid");
  const redeemArgs = { walletAddress: accountWallet, signingAddress: accountWallet, walletType: "EOA", conditionId };
  const sdkUnresolved = await callTool(artifact, redeemTool, redeemArgs, { fixtures: true, fixtureScenario: "redeem-unresolved" });
  if (sdkUnresolved.structuredContent.status !== "UNRESOLVED" || sdkUnresolved.structuredContent.transactionPreview.length) fail("nonredeemable indexed positions produced a preview", "redemption_preview_invalid");
  const sdkWrongOwner = await callTool(artifact, redeemTool, { ...redeemArgs, walletAddress: "0x0000000000000000000000000000000000000002" }, { fixtures: true, fixtureScenario: "redeem-wrong-owner" });
  if (sdkWrongOwner.structuredContent.transactionPreview.length || sdkWrongOwner.structuredContent.status !== "UNKNOWN") fail("redemption accepted a wallet not bound to the SDK account", "redemption_preview_invalid");
  const sdkEmpty = await callTool(artifact, redeemTool, redeemArgs, { fixtures: true, fixtureScenario: "redeem-insufficient-balance" });
  if (sdkEmpty.structuredContent.status !== "NO_POSITION" || sdkEmpty.structuredContent.transactionPreview.length) fail("sdkMissing indexed positions produced a preview", "redemption_preview_invalid");
  const gaslessPreview = await callTool(artifact, redeemTool, { ...redeemArgs, walletAddress: await fixtureWallet(fixtureSigner.address), walletType: "DEPOSIT_WALLET" },
    { fixtures: true, fixtureScenario: "redeem-gasless" });
  if (gaslessPreview.structuredContent.status !== "UNSUPPORTED" || gaslessPreview.structuredContent.execution !== "EXTERNAL_ACTION_REQUIRED" || gaslessPreview.structuredContent.transactionPreview.length) fail("gasless redemption invented direct-call or relayer support", "redemption_preview_invalid");
  const wrongRedeemAsset = await callTool(artifact, redeemTool, redeemArgs, { fixtures: true, fixtureScenario: "redeem-wrong-asset" });
  if (wrongRedeemAsset.structuredContent.status !== "UNKNOWN" || wrongRedeemAsset.structuredContent.transactionPreview.length) fail("redemption accepted a position asset outside SDK market outcomes", "redemption_preview_invalid");
  for (const scenario of ["redeem-resolved", "redeem-negative-risk", "redeem-missing-approval", "redeem-v2-resolved", "redeem-v2-both"]) {
    const v2 = scenario.startsWith("redeem-v2");
    const result = await callTool(artifact, redeemTool, { ...redeemArgs, conditionId: v2 ? `0x01${"11".repeat(30)}00` : conditionId }, { fixtures: true, fixtureScenario: scenario });
    const preview = result.structuredContent.transactionPreview;
    const expectedCount = scenario === "redeem-v2-both" ? 2 : 1;
    if (result.structuredContent.status !== "PREPARED" || preview.length !== expectedCount || result.structuredContent.execution !== "EXTERNAL_ACTION_REQUIRED"
      || result.structuredContent.routeApproval !== null || "io.paybox/transactionProposal" in result.structuredContent) fail(`${scenario}: SDK unsigned preview or unsupported PayBox boundary changed`, "redemption_preview_invalid");
    const decoded = decodeFunctionData({ abi: v2 ? v2RedeemAbi : ctfRedeemAbi, data: preview[0].data });
    if (decoded.functionName !== (v2 ? "redeem" : "redeemPositions")) fail("SDK redemption call has the wrong route ABI", "redemption_preview_invalid");
    if (v2 && decoded.args[2] !== 10_000_000n) fail("SDK redemption changed the actual position amount", "redemption_preview_invalid");
  }
  const toolNames = new Set(tools.map((tool) => tool.name));
  const textOnlyUncovered = [...toolNames].filter((name) => !textOnlyToolCoverage.has(name));
  if (textOnlyUncovered.length > 0) fail(`text-only client did not exercise: ${textOnlyUncovered.join(", ")}`, "text_output_coverage_invalid");
  for (const name of ["submit_order", "submit_fak_order", "get_order_status", "cancel_order", "get_portfolio", "get_trading_readiness", "prepare_redeem"]) {
    if (!toolNames.has(name)) fail(`${name} was not registered`, "tool_catalog_invalid");
  }
  return {
    status: "passed",
    deterministicCases: [
      "official SDK exact five-share FAK/FOK submission, no BUY resize, fee-inclusive cap rejection",
      "Deposit Wallet stateless finalizer matches the official SDK byte-for-byte",
      "discovery makes no network calls; successful order-read HTTP status is observed, not inferred",
      "BUY FAK preserves exact signed limit, size, precision, and fee-inclusive cap", "lack of visible liquidity does not block bounded FAK preparation", "no ExecutionApproval signature is required", "signed order is accepted for exactly one intercepted CLOB POST", "undocumented 300-second ClobAuth cutoff removed", "undocumented order-timestamp freshness cutoff removed", "SELL FAK preserves exact signed minimum price and size", "market fee descriptor and exact fee calculation",
      "EOA Type 0 FAK BUY remains compatible through submit_fak_order", "EOA Type 0 FOK SELL reaches one POST with its exact prepared type and amounts", "Deposit Wallet Type 3 FAK BUY uses the shared submit_order handler", "Deposit Wallet Type 3 FOK BUY preserves ERC-7739 wrapping and FOK", "insufficient visible depth does not locally reject FOK; the CLOB's rejection remains FOK", "mismatched legacy FAK submission rejects a prepared FOK without a POST", "ambiguous FOK outcome remains UNKNOWN after one POST and one read-only reconciliation", "FAK partial fill and CLOB-canceled remainder are reflected by status read-back", "FOK full fill is reflected by authoritative status read-back",
      "reject invalid Polymarket order signature", "reject real provider geoblock", "missing CLOB credentials handled", "Deposit Wallet TypedDataSign preparation", "local smart-wallet signer recovery is distinct from deferred CLOB acceptance", "Deposit Wallet ERC-7739 order reaches exactly one intercepted CLOB POST without Polygon RPC",
      "121s book age is informational for preparation", "future, invalid, missing, and stale book timestamps do not block bounded FAK execution", "changed minimum decrease and still-valid tick are accepted", "increased minimum and invalid current tick reject the exact signed order", "zero current minimum is rejected as invalid provider data", "changed risk mode rejects an incompatible exchange domain", "restricted Gamma metadata omitted and does not reject preparation/submission", "market and quote responses omit removed eligibility metadata", "unsigned book metadata does not change EIP-712 signature validation", "51s quote remains labeled stale", "51s book age alone does not block bounded FAK execution", "timeout, HTTP 429/5xx, malformed success, and malformed order IDs reconcile once, retain status, and never repost; authoritative read-back resolves a confirmed fill", "HTTP 400/401/403 POST errors retain sanitized classifications and status", "cancel_order reports structured L1/L2/403 failures, issues one DELETE, and reconciles ambiguous outcomes at most once", "provider-invalid structured diagnostics", "reject unsafe CLOB salt precision", "reject fee-inclusive cap overrun", "reject wrong outcome asset",
      "all 16 MCP tools return machine-readable JSON content for text-only clients", "search-to-quote-to-PayBox-signing-to-validation-to-submission workflow using content text only", "FOK text response preserves provider rejection without local depth guarantees",
      "team-attributed news", "PL/PD/SA/CL fixture mapping", "documented team-form filters with mixed-competition history filtering", "form counts and explanations for 5/5, 5/4, 5/0, and 0/0 histories",
      "safe team-form HTTP 403 permission and 429 rate-limit diagnostics", "API-Football competition-scoped enrichment, upstream cross-year season reuse, independent IDs, exact fixture matching, and cutoff date",
      "provider 403, 204, HTTP 200 error envelope, unavailable/missing stats, mismatched names, kickoff conflicts, and ambiguous duplicates do not replace baseline data", "Poisson probability normalization and venue-specific API-Football and football-data fallback inputs",
      "CLOB multilevel depth-weighted price, fee-inclusive cost, positive and negative edge, partial fill, no liquidity, unsupported market rules, and honest SELL limitation",
      "analysis recalculates quote freshness, reports invalid or future timestamps as unknown, and labels stale edges as historical",
      "soccer skill continuation for missing xG, missing injury reports, and unavailable browser tools",
      "football-data.org HTTP/network/timeout/invalid-response fallback; valid empty response stays primary-only",
      "fallback date coverage is complete only for queried days; later dates require explicit continuation",
      "API-Football fallback errors, empty data, date discovery, exact identity, and namespaced provider IDs",
      "API-Football competition IDs, starting-year season selection, wrong league/season rejection, unknown-season no-request diagnostics, and response cap",
      "fallback fixture ambiguity, kickoff conflicts, missing statistics, and source provenance",
      "host-attested identity evidence and exact market mapping consistency required for fallback probability/edge; source URLs are not fetched",
      "official v2 OPEN portfolio includes REDEEMABLE positions and preserves cursor pagination", "public portfolio address is not wallet proof", "16-tool catalog with one shared FAK/FOK submit tool",
      "official SDK indexed trading approval state; funding, gas, per-order readiness and eligibility stay UNKNOWN; no RPC scanner or approval writes",
      "redemption requires exact SDK owner/condition identity and indexed redeemability; indexed state is not fresh chain finality", "standard and negative-risk CTF redemption previews use their official adapters", "SDK V2 redemption previews retain each held outcome and exact chain-read amount without signing or broadcasting", "read-only tools never sign or broadcast redemption transactions",
      "ClobAuth and Order intents match PayBox's documented typedData object contract",
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

export async function runOperation(artifact, operation, { fixtures = false, fixtureScenario, expectedSignerAddress, expectedMakerAddress } = {}) {
  if (fixtures && operation.method === "tools/call" && ["prepare_order_signing", "prepare_redeem"].includes(operation.params.name)) await fixtureAuth(operation.params.arguments);
  const home = await mkdtemp(resolve(tmpdir(), "paybox-plugin-conformance-"));
  try {
    const args = fixtures ? ["--import", resolve(dirname(artifact), "../tests/network-fixtures.mjs"), artifact] : [artifact];
    return await withProcess(process.execPath, args, {
      cwd: dirname(artifact),
      env: {
        HOME: home, NODE_ENV: "production", NO_COLOR: "1", PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        ...(fixtureScenario === undefined ? {} : { POLYSCOPE_TEST_SCENARIO: fixtureScenario }),
        ...(expectedSignerAddress === undefined ? {} : { POLYSCOPE_TEST_EXPECTED_SIGNER: expectedSignerAddress }),
        ...(expectedMakerAddress === undefined ? {} : { POLYSCOPE_TEST_EXPECTED_MAKER: expectedMakerAddress }),
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
