import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createHmac } from "node:crypto";
import {
  bytesToHex,
  concatHex,
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  hexToBytes,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import * as z from "zod/v4";

const PROTOCOL_VERSION = "2026-07-28";
const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
const GEOBLOCK_API = "https://polymarket.com/api/geoblock";
const ESPN_SOCCER_FEED = "https://www.espn.com/espn/rss/soccer/news";
const FOOTBALL_DATA_API = "https://api.football-data.org/v4";
const NEWS_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_RSS_BYTES = 256 * 1024;
const RSS_XML_PARSER = new XMLParser({ ignoreAttributes: true, processEntities: false, trimValues: false });
const ZERO32 = `0x${"0".repeat(64)}` as const;
const ORDER_TYPE = "Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)";
const EIP712_DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const ORDER_FIELDS = [
  { name: "salt", type: "uint256" },
  { name: "maker", type: "address" },
  { name: "signer", type: "address" },
  { name: "tokenId", type: "uint256" },
  { name: "makerAmount", type: "uint256" },
  { name: "takerAmount", type: "uint256" },
  { name: "side", type: "uint8" },
  { name: "signatureType", type: "uint8" },
  { name: "timestamp", type: "uint256" },
  { name: "metadata", type: "bytes32" },
  { name: "builder", type: "bytes32" },
] as const;
const TYPED_DATA_SIGN_FIELDS = [
  { name: "contents", type: "Order" },
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
  { name: "salt", type: "bytes32" },
] as const;
const DOMAIN_BY_MARKET = {
  v2: { version: "3", verifyingContract: "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa" },
  ctf: {
    regular: { version: "2", verifyingContract: "0xE111180000d2663C0091e4f400237545B87B996B" },
    negRisk: { version: "2", verifyingContract: "0xe2222d279d744050d28e00520010520000310F59" },
  },
} as const;
const TICK_RULES = {
  "0.1": { priceDecimals: 1, amountDecimals: 3 },
  "0.01": { priceDecimals: 2, amountDecimals: 4 },
  "0.005": { priceDecimals: 3, amountDecimals: 5 },
  "0.0025": { priceDecimals: 4, amountDecimals: 6 },
  "0.001": { priceDecimals: 3, amountDecimals: 5 },
  "0.0001": { priceDecimals: 4, amountDecimals: 6 },
} as const;
const TICK_SIZES = ["0.1", "0.01", "0.005", "0.0025", "0.001", "0.0001"] as const;
const FAK = "FAK" as const;

const preparationErrorCodeSchema = z.enum([
  "PS_MARKET_IDENTITY", "PS_PROVIDER_INVALID", "PS_PROVIDER_UNAVAILABLE",
  "PS_PROVIDER_TIMEOUT", "PS_RESPONSE_TOO_LARGE", "PS_MARKET_CLOSED", "PS_MARKET_UNSUPPORTED",
  "PS_MARKET_VERSION", "PS_FEE_INVALID", "PS_WALLET_BINDING", "PS_AMOUNT_INVALID", "PS_AMOUNT_PRECISION",
  "PS_PRICE_INVALID", "PS_SIZE_BELOW_MINIMUM", "PS_SPENDING_CAP",
]);
const preparationFreshnessSchema = z.object({
  bookAgeMs: z.number().int().nonnegative().nullable(),
}).strict();

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const decimalIdSchema = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const typedFieldSchema = z.object({ name: z.string(), type: z.string() }).strict();
const typedDataSchema = z.object({
  domain: z.object({
    name: z.string(), version: z.string(), chainId: z.number().int(),
    verifyingContract: addressSchema.optional(),
  }).strict(),
  types: z.record(z.string(), z.array(typedFieldSchema)),
  primaryType: z.string(),
  message: z.record(z.string(), z.unknown()),
}).strict();
const requestWalletSignIntentSchema = z.object({
  op: z.literal("typedData"), typedData: typedDataSchema,
}).strict();

const gammaMarketSchema = z.object({
  id: z.union([z.string(), z.number()]),
  question: z.string().optional(),
  slug: z.string().optional(),
  description: z.string().nullable().optional(),
  resolutionSource: z.string().nullable().optional(),
  conditionId: z.string().nullable().optional(),
  outcomes: z.union([z.string(), z.array(z.string())]).optional(),
  clobTokenIds: z.union([z.string(), z.array(z.string())]).optional(),
  positionIds: z.array(z.string()).nullable().optional(),
  outcomePrices: z.union([z.string(), z.array(z.string())]).optional(),
  volume: z.union([z.string(), z.number()]).nullable().optional(),
  volume24hr: z.union([z.string(), z.number()]).nullable().optional(),
  liquidity: z.union([z.string(), z.number()]).nullable().optional(),
  active: z.boolean().optional(),
  closed: z.boolean().optional(),
  acceptingOrders: z.boolean().optional(),
  enableOrderBook: z.boolean().optional(),
  endDate: z.string().nullable().optional(),
  negRisk: z.boolean().optional(),
  version: z.enum(["v1", "v2"]).nullable().optional(),
}).strip();
const searchEventSchema = z.object({
  title: z.string().optional(), markets: z.array(gammaMarketSchema).default([]),
}).strip();
const searchResponseSchema = z.object({ events: z.array(searchEventSchema) }).passthrough();
const bookSchema = z.object({
  asset_id: decimalIdSchema,
  market: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  timestamp: z.string().nullable().optional(),
  bids: z.array(z.object({ price: z.string(), size: z.string() }).strip()).default([]),
  asks: z.array(z.object({ price: z.string(), size: z.string() }).strip()).default([]),
  last_trade_price: z.string().nullable().optional(),
  min_order_size: z.string(),
  tick_size: z.enum(TICK_SIZES),
  neg_risk: z.boolean(),
  version: z.enum(["v1", "v2"]).nullable().optional(),
}).strip();

const marketResultSchema = z.object({
  eventTitle: z.string(), marketId: z.string(), question: z.string(), slug: z.string().nullable(),
  conditionId: z.string(), version: z.enum(["v1", "v2"]).nullable(), negRisk: z.boolean(),
  acceptingOrders: z.boolean().nullable(),
  endDate: z.string().nullable(), resolutionRules: z.string().nullable(), resolutionSource: z.string().nullable(),
  volume: z.union([z.string(), z.number()]).nullable(), volume24h: z.union([z.string(), z.number()]).nullable(),
  liquidity: z.union([z.string(), z.number()]).nullable(),
  outcomes: z.array(z.object({ name: z.string(), assetId: decimalIdSchema, gammaPrice: z.string().nullable() }).strict()),
  yesAssetId: decimalIdSchema.nullable(), noAssetId: decimalIdSchema.nullable(), observedAt: z.string().datetime(),
}).strict();
const sideSchema = z.enum(["BUY", "SELL"]);
const quoteLevelSchema = z.object({ price: z.string(), size: z.string() }).strict();
const quoteResultSchema = z.object({
  marketId: z.string(), question: z.string(), outcome: z.string(), assetId: decimalIdSchema,
  version: z.enum(["v1", "v2"]).nullable(),
  marketAcceptingOrders: z.boolean().nullable(), tickSize: z.enum(TICK_SIZES), minOrderSize: z.string(), side: sideSchema,
  availability: z.enum(["AVAILABLE", "NO_LIQUIDITY"]), freshness: z.enum(["FRESH", "STALE", "UNKNOWN"]),
  staleAfterSeconds: z.literal(30), bestBid: z.string().nullable(), bestAsk: z.string().nullable(),
  spread: z.string().nullable(), levels: z.array(quoteLevelSchema), totalAvailableShares: z.string(),
  requestedSize: z.string().nullable(), fillableSize: z.string().nullable(), unfilledSize: z.string().nullable(),
  worstPrice: z.string().nullable(), averagePrice: z.string().nullable(), grossAmountPusd: z.string().nullable(),
  feeRate: z.string().nullable(), feeExponent: z.number().int().min(0).max(6).nullable(), estimatedFeePusd: z.string().nullable(),
  bookTimestamp: z.string().nullable(), bookAgeMs: z.number().int().nullable(), observedAt: z.string().datetime(),
  source: z.literal("Polymarket CLOB"),
}).strict();
const providerAvailabilitySchema = z.enum(["AVAILABLE", "UNAVAILABLE"]);
const providerFreshnessSchema = z.enum(["AVAILABLE", "STALE", "UNKNOWN"]);
const soccerNewsItemSchema = z.object({
  title: z.string(), summary: z.string().nullable(), url: z.string().url(),
  publishedAt: z.string().nullable(), publishedAtUtc: z.string().datetime().nullable(),
  matchedTeams: z.array(z.string()), reportStatus: z.literal("REPORTED"), status: providerFreshnessSchema,
}).strict();
const soccerNewsOutputSchema = z.object({
  availability: providerAvailabilitySchema, reason: z.string().nullable(), provider: z.literal("ESPN"),
  sourceUrl: z.string().url(), observedAt: z.string().datetime(), staleAfterHours: z.literal(24),
  teams: z.array(z.string()), contentIsUntrusted: z.literal(true), items: z.array(soccerNewsItemSchema),
}).strict();
const soccerObservedResultSchema = z.object({
  fixtureId: z.string(), date: z.string().nullable(), opponent: z.string().nullable(), venue: z.enum(["HOME", "AWAY"]),
  score: z.string(), result: z.enum(["W", "D", "L"]),
}).strict();
const soccerFixtureSchema = z.object({
  fixtureId: z.string(), competition: z.string(), leagueProviderId: z.string(),
  homeTeam: z.string(), homeTeamProviderId: z.string(), awayTeam: z.string(), awayTeamProviderId: z.string(),
  kickoffUtc: z.string().datetime(), status: z.string(), homeScore: z.number().int().nonnegative().nullable(),
  awayScore: z.number().int().nonnegative().nullable(), providerUpdatedAt: z.string().datetime().nullable(),
  formCoverage: z.enum(["COMPLETE_LAST_5", "PARTIAL", "UNAVAILABLE"]), formReason: z.string().nullable(),
  homeFormCoverage: z.enum(["COMPLETE_LAST_5", "PARTIAL", "UNAVAILABLE"]), homeFormReason: z.string().nullable(),
  awayFormCoverage: z.enum(["COMPLETE_LAST_5", "PARTIAL", "UNAVAILABLE"]), awayFormReason: z.string().nullable(),
  homeFormResultCount: z.number().int().nonnegative(), awayFormResultCount: z.number().int().nonnegative(),
  homeRecentResults: z.array(soccerObservedResultSchema), awayRecentResults: z.array(soccerObservedResultSchema),
}).strict();
const soccerSourceSchema = z.object({
  provider: z.literal("football-data.org"), purpose: z.enum(["FIXTURES_AND_RESULTS", "EXACT_FIXTURE", "TEAM_FORM"]),
  url: z.string().url(), observedAt: z.string().datetime(),
  teamProviderId: z.string().optional(), teamName: z.string().optional(),
  availability: providerAvailabilitySchema.optional(), returnedResultCount: z.number().int().nonnegative().nullable().optional(),
  reason: z.string().nullable().optional(),
}).strict();
const soccerResearchOutputSchema = z.object({
  availability: providerAvailabilitySchema, reason: z.string().nullable(), league: z.enum(["PL", "PD", "SA", "CL"]),
  competition: z.string(), provider: z.literal("football-data.org"), sources: z.array(soccerSourceSchema), observedAt: z.string().datetime(),
  season: z.string().nullable(), leagueProviderId: z.string().nullable(), coverage: z.enum(["RETURNED_MATCHES", "UNAVAILABLE"]),
  returnedEventCount: z.number().int(), fixtures: z.array(soccerFixtureSchema),
}).strict();
const typedOutputSchema = z.object({
  signingAddress: addressSchema,
  timestamp: z.string(),
  nonce: z.string(),
  typedData: typedDataSchema,
  requestWalletSignIntent: requestWalletSignIntentSchema,
}).strict();
const walletTypeSchema = z.enum(["EOA", "PROXY", "SAFE", "DEPOSIT_WALLET"]);
const preparedOrderBaseSchema = z.object({
  market: z.object({
    id: z.string().regex(/^[0-9]{1,32}$/), conditionId: z.string().regex(/^0x[0-9a-fA-F]{64}$/), version: z.enum(["v1", "v2"]), outcome: z.string(), negRisk: z.boolean(),
    acceptingOrders: z.boolean().nullable(),
    tickSize: z.enum(TICK_SIZES),
    minOrderSize: z.string(), bookTimestamp: z.string().nullable(),
  }).strict(),
  wallet: z.object({
    type: walletTypeSchema, makerAddress: addressSchema, signingAddress: addressSchema,
    orderSignerAddress: addressSchema, signatureType: z.number().int().min(0).max(3),
  }).strict(),
  order: z.object({
    salt: z.string().regex(/^(0|[1-9][0-9]{0,77})$/), timestamp: z.string().regex(/^[0-9]{1,16}$/), assetId: decimalIdSchema, side: sideSchema,
    price: z.string(), size: z.string(), maxNominalPusd: z.string(), maxGrossPusd: z.string(),
    maxFeePusd: z.string(), feeRate: z.string().regex(/^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/),
    feeExponent: z.number().int().min(0).max(6), orderType: z.literal("FAK"), makerAmount: z.string(),
    takerAmount: z.string(), metadata: z.string(), builder: z.string(),
  }).strict(),
}).strict();
const preparedOrderSchema = preparedOrderBaseSchema.extend({ typedData: typedDataSchema }).strict();

type PreparedOrder = z.infer<typeof preparedOrderSchema>;
type PreparedOrderBase = z.infer<typeof preparedOrderBaseSchema>;
type TypedPayload = z.infer<typeof typedDataSchema>;
const clobAuthSchema = z.object({
  timestamp: z.string().regex(/^[0-9]{1,16}$/), nonce: z.string().regex(/^(0|[1-9][0-9]{0,77})$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
}).strict();
const clobMarketInfoSchema = z.object({
  fd: z.object({ r: z.number().finite().min(0).max(1), e: z.number().int().min(0).max(6) }).passthrough().nullable().optional(),
}).passthrough();
const clobCredentialSchema = z.object({ apiKey: z.string().min(1), secret: z.string().min(1), passphrase: z.string().min(1) }).passthrough();
const orderReadSchema = z.object({
  id: z.string().optional(), status: z.string().optional(), order_type: z.string().optional(),
  original_size: z.string().optional(), size_matched: z.string().optional(), asset_id: z.string().optional(),
  side: z.string().optional(), associate_trades: z.array(z.string()).optional(),
}).passthrough();
const clobOrderResponseSchema = z.object({
  success: z.boolean().optional(), orderID: z.string().optional(), status: z.string().optional(),
  errorMsg: z.string().optional(), makingAmount: z.string().optional(), takingAmount: z.string().optional(),
  tradeIDs: z.array(z.string()).optional(), transactionsHashes: z.array(z.string()).optional(),
}).passthrough();
const orderLifecycleSchema = z.enum([
  "PREPARED", "APPROVAL_PENDING", "REJECTED", "SUBMITTED", "OPEN", "PARTIALLY_FILLED",
  "FILLED", "CANCELLED", "FAILED", "UNKNOWN",
]);
const executionResultSchema = z.object({
  status: orderLifecycleSchema, orderId: z.string().nullable(), orderType: z.literal("FAK"),
  requestedSize: z.string(), filledSize: z.string().nullable(), remainingSize: z.string().nullable(),
  tradeIds: z.array(z.string()), message: z.string(), errorCode: z.string().regex(/^PS_[A-Z_]+$/).nullable().default(null),
}).strict();
const geoblockSchema = z.object({ blocked: z.boolean() }).passthrough();
const positionsResponseSchema = z.array(z.object({
  condition_id: z.string(), title: z.string().optional(), outcome: z.string().optional(),
  current_size: z.number().finite(), avg_price: z.number().finite().optional(),
  current_price: z.number().finite().optional(), current_value: z.number().finite().optional(),
  realized_pnl: z.number().finite().optional(), unrealized_pnl: z.number().finite().optional(),
  total_pnl: z.number().finite().optional(), redeemable: z.boolean().optional(), token_id: z.string().optional(),
}).passthrough());
const positionsPageSchema = z.object({
  data: positionsResponseSchema,
  pagination: z.object({
    has_more: z.boolean(), limit: z.number().int().nonnegative(),
    next_cursor: z.string().nullable(), offset: z.number().int().nonnegative(),
  }).passthrough(),
}).passthrough();

async function getJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) throw new Error(`PS_PROVIDER_UNAVAILABLE: Polymarket read returned HTTP ${response.status}.`);
    let body: string;
    try { body = await boundedResponseText(response, 1_000_000); }
    catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") throw new Error("PS_PROVIDER_TIMEOUT: Polymarket read timed out.");
      throw new Error("PS_RESPONSE_TOO_LARGE: Provider response exceeded the 1 MiB limit.");
    }
    try { return JSON.parse(body) as unknown; }
    catch { throw new Error("PS_PROVIDER_INVALID: Polymarket returned invalid JSON."); }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("PS_")) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") throw new Error("PS_PROVIDER_TIMEOUT: Polymarket read timed out.");
    throw new Error("PS_PROVIDER_UNAVAILABLE: Polymarket read failed before a response was received.");
  }
}

type ProviderFetchResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: string };

function footballDataHttpReason(status: number): string {
  switch (status) {
    case 400: return "football-data.org rejected the request parameters (HTTP 400).";
    case 401: return "football-data.org rejected or did not receive the API token (HTTP 401).";
    case 403: return "football-data.org denied access to this resource or competition (HTTP 403); check token permissions and plan coverage.";
    case 404: return "football-data.org resource was not found (HTTP 404).";
    case 429: return "football-data.org rate limit reached (HTTP 429).";
    default: return status >= 500
      ? `football-data.org is temporarily unavailable (HTTP ${status}).`
      : `football-data.org request failed (HTTP ${status}).`;
  }
}

async function getProviderJson(url: string): Promise<ProviderFetchResult> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return { ok: false, reason: footballDataHttpReason(response.status) };
    const body = await boundedResponseText(response, 1_000_000);
    try {
      const data: unknown = JSON.parse(body);
      return { ok: true, data };
    } catch {
      return { ok: false, reason: "football-data.org returned invalid JSON." };
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error && error.message === "response_too_large"
        ? "football-data.org response exceeded the 1 MB limit."
        : error instanceof DOMException && error.name === "TimeoutError"
          ? "football-data.org request timed out."
          : "football-data.org request failed before receiving a response.",
    };
  }
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) throw new Error("response_too_large");
  const reader = response.body?.getReader();
  if (!reader) {
    const body = await response.text();
    if (Buffer.byteLength(body) > maxBytes) throw new Error("response_too_large");
    return body;
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error("response_too_large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function parseJsonArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return z.array(z.string()).parse(value);
  if (value === undefined) return [];
  const parsed: unknown = JSON.parse(value);
  return z.array(z.string()).parse(parsed);
}

function marketAssetIds(market: z.infer<typeof gammaMarketSchema>): string[] {
  if (market.version === "v2") return z.array(z.string()).parse(market.positionIds ?? []);
  return parseJsonArray(market.clobTokenIds);
}

function optionalJsonArray(value: string | string[] | undefined): string[] {
  try { return parseJsonArray(value); } catch { return []; }
}

function marketOutcomeAssets(market: z.infer<typeof gammaMarketSchema>) {
  try {
    const outcomes = parseJsonArray(market.outcomes);
    const assetIds = marketAssetIds(market);
    if (outcomes.length < 2 || outcomes.length !== assetIds.length) return null;
    const prices = optionalJsonArray(market.outcomePrices);
    const mapped = outcomes.map((name, index) => ({
      name,
      assetId: assetIds[index] ?? "",
      gammaPrice: prices[index] ?? null,
    }));
    if (mapped.some((outcome) => !decimalIdSchema.safeParse(outcome.assetId).success)) return null;
    return mapped;
  } catch {
    return null;
  }
}

function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction.length > 0 ? `.${fraction}` : ""}`;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function decodeRssEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#(?:[0-9]+|x[0-9a-f]+));/gi, (entity) => {
    const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'" };
    const replacement = named[entity.toLowerCase()];
    if (replacement !== undefined) return replacement;
    const hexadecimal = /^&#x([0-9a-f]+);$/i.exec(entity);
    const decimal = /^&#([0-9]+);$/.exec(entity);
    const codePoint = hexadecimal ? Number.parseInt(hexadecimal[1] ?? "", 16) : decimal ? Number.parseInt(decimal[1] ?? "", 10) : Number.NaN;
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? String.fromCodePoint(codePoint)
      : entity;
  });
}

const rssItemSchema = z.object({
  title: z.string().optional(), link: z.string().optional(), description: z.string().optional(), pubDate: z.string().optional(),
}).passthrough();
const rssDocumentSchema = z.object({
  rss: z.object({
    channel: z.object({ item: z.union([rssItemSchema, z.array(rssItemSchema)]).optional() }).passthrough(),
  }).passthrough(),
}).passthrough();

function rssItems(value: unknown): z.infer<typeof rssItemSchema>[] | null {
  const result = rssDocumentSchema.safeParse(value);
  if (!result.success) return null;
  const items = result.data.rss.channel.item;
  return items === undefined ? [] : Array.isArray(items) ? items : [items];
}

const SPORTS_COMPETITIONS = {
  PL: { name: "Premier League", competitionId: "2021" },
  PD: { name: "LaLiga", competitionId: "2014" },
  SA: { name: "Serie A", competitionId: "2019" },
  CL: { name: "UEFA Champions League", competitionId: "2001" },
} as const;

type SoccerLeague = keyof typeof SPORTS_COMPETITIONS;

const footballTeamSchema = z.object({ id: z.number().int().positive(), name: z.string().min(1) }).passthrough();
const footballDataMatchSchema = z.object({
  id: z.number().int().positive(), utcDate: z.string().datetime(), status: z.string().min(1),
  lastUpdated: z.string().datetime().nullable().optional(),
  competition: z.object({ id: z.number().int().positive().optional(), code: z.string().optional(), name: z.string().optional() }).passthrough().optional(),
  homeTeam: footballTeamSchema, awayTeam: footballTeamSchema,
  score: z.object({ fullTime: z.object({
    home: z.number().int().nonnegative().nullable().optional(),
    away: z.number().int().nonnegative().nullable().optional(),
  }).passthrough().optional() }).passthrough(),
}).passthrough();
const footballDataMatchesSchema = z.object({ matches: z.array(footballDataMatchSchema) }).passthrough();

function footballDataUrl(path: string, parameters: Record<string, string> = {}): string {
  const url = new URL(`${FOOTBALL_DATA_API}/${path}`);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.toString();
}

function mapFootballResult(match: z.infer<typeof footballDataMatchSchema>, teamId: number): z.infer<typeof soccerObservedResultSchema> | null {
  const homeScore = match.score.fullTime?.home;
  const awayScore = match.score.fullTime?.away;
  if (match.status !== "FINISHED" || homeScore == null || awayScore == null) return null;
  const isHome = match.homeTeam.id === teamId;
  const isAway = match.awayTeam.id === teamId;
  if (!isHome && !isAway) return null;
  const own = isHome ? homeScore : awayScore;
  const opponent = isHome ? awayScore : homeScore;
  return {
    fixtureId: String(match.id), date: match.utcDate.slice(0, 10),
    opponent: isHome ? match.awayTeam.name : match.homeTeam.name,
    venue: isHome ? "HOME" : "AWAY", score: `${own}-${opponent}`,
    result: own === opponent ? "D" : own > opponent ? "W" : "L",
  };
}

function mapFootballFixture(
  match: z.infer<typeof footballDataMatchSchema>,
  league: SoccerLeague,
  homeRecentResults: z.infer<typeof soccerObservedResultSchema>[],
  awayRecentResults: z.infer<typeof soccerObservedResultSchema>[],
  formReason: string | null,
  homeFormReason: string | null = formReason,
  awayFormReason: string | null = formReason,
): z.infer<typeof soccerFixtureSchema> | null {
  if (match.competition?.code !== league) return null;
  const homeFormCoverage = homeRecentResults.length === 5 ? "COMPLETE_LAST_5" as const : homeRecentResults.length > 0 ? "PARTIAL" as const : "UNAVAILABLE" as const;
  const awayFormCoverage = awayRecentResults.length === 5 ? "COMPLETE_LAST_5" as const : awayRecentResults.length > 0 ? "PARTIAL" as const : "UNAVAILABLE" as const;
  const formCoverage = homeFormCoverage === "COMPLETE_LAST_5" && awayFormCoverage === "COMPLETE_LAST_5"
    ? "COMPLETE_LAST_5" as const : homeRecentResults.length > 0 || awayRecentResults.length > 0 ? "PARTIAL" as const : "UNAVAILABLE" as const;
  return {
    fixtureId: String(match.id), competition: SPORTS_COMPETITIONS[league].name, leagueProviderId: league,
    homeTeam: match.homeTeam.name, homeTeamProviderId: String(match.homeTeam.id),
    awayTeam: match.awayTeam.name, awayTeamProviderId: String(match.awayTeam.id),
    kickoffUtc: match.utcDate, status: match.status,
    homeScore: match.score.fullTime?.home ?? null, awayScore: match.score.fullTime?.away ?? null,
    providerUpdatedAt: match.lastUpdated ?? null,
    formCoverage,
    formReason: formCoverage === "COMPLETE_LAST_5" ? null : formReason ?? "football-data.org returned partial recent results.",
    homeFormCoverage, homeFormReason,
    awayFormCoverage, awayFormReason,
    homeFormResultCount: homeRecentResults.length, awayFormResultCount: awayRecentResults.length,
    homeRecentResults, awayRecentResults,
  };
}

function validDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

async function getSoccerNews(limit: number, teams: string[]): Promise<z.infer<typeof soccerNewsOutputSchema>> {
  const observedAt = new Date().toISOString();
  const requestedTeams = [...new Set(teams.map((team) => team.trim()).filter(Boolean))];
  try {
    const response = await fetch(ESPN_SOCCER_FEED, {
      headers: { accept: "application/rss+xml, application/xml, text/xml" },
      redirect: "error",
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) {
      return soccerNewsOutputSchema.parse({
        availability: "UNAVAILABLE", reason: `ESPN returned HTTP ${response.status}.`, provider: "ESPN",
        sourceUrl: ESPN_SOCCER_FEED, observedAt, staleAfterHours: 24, teams: requestedTeams, contentIsUntrusted: true, items: [],
      });
    }
    const xml = await boundedResponseText(response, MAX_RSS_BYTES);
    if (/<!DOCTYPE\b/i.test(xml) || XMLValidator.validate(xml) !== true) {
      return soccerNewsOutputSchema.parse({
        availability: "UNAVAILABLE", reason: "ESPN feed did not pass safe XML validation.", provider: "ESPN",
        sourceUrl: ESPN_SOCCER_FEED, observedAt, staleAfterHours: 24, teams: requestedTeams, contentIsUntrusted: true, items: [],
      });
    }
    const parsed: unknown = RSS_XML_PARSER.parse(xml);
    const sourceItems = rssItems(parsed);
    if (sourceItems === null) {
      return soccerNewsOutputSchema.parse({
        availability: "UNAVAILABLE", reason: "ESPN feed did not match the expected RSS shape.", provider: "ESPN",
        sourceUrl: ESPN_SOCCER_FEED, observedAt, staleAfterHours: 24, teams: requestedTeams, contentIsUntrusted: true, items: [],
      });
    }
    const observedAtMs = Date.parse(observedAt);
    const items = sourceItems.flatMap((item) => {
      if (!item.title || !item.link || item.link !== item.link.trim()) return [];
      let articleUrl: URL;
      try { articleUrl = new URL(item.link); } catch { return []; }
      const trustedHost = articleUrl.protocol === "https:" &&
        (articleUrl.hostname === "espn.com" || articleUrl.hostname.endsWith(".espn.com") ||
          articleUrl.hostname === "espn.in" || articleUrl.hostname.endsWith(".espn.in"));
      if (!trustedHost) return [];
      const publishedAt = item.pubDate ? decodeRssEntities(item.pubDate) : null;
      const publishedMs = publishedAt === null ? Number.NaN : Date.parse(publishedAt);
      const ageMs = observedAtMs - publishedMs;
      const status = !Number.isFinite(publishedMs) || ageMs < 0
        ? "UNKNOWN" as const
        : ageMs > NEWS_STALE_AFTER_MS ? "STALE" as const : "AVAILABLE" as const;
      const title = decodeRssEntities(item.title);
      const summary = item.description === undefined ? null : decodeRssEntities(item.description);
      const searchable = `${title} ${summary ?? ""}`.toLocaleLowerCase("en-US");
      const matchedTeams = requestedTeams.filter((team) => searchable.includes(team.toLocaleLowerCase("en-US")));
      if (matchedTeams.length === 0) return [];
      return [{
        title,
        summary,
        url: item.link,
        publishedAt,
        publishedAtUtc: Number.isFinite(publishedMs) ? new Date(publishedMs).toISOString() : null,
        matchedTeams,
        reportStatus: "REPORTED" as const,
        status,
      }];
    }).slice(0, limit);
    return soccerNewsOutputSchema.parse({
      availability: items.length > 0 ? "AVAILABLE" : "UNAVAILABLE",
      reason: items.length > 0 ? null : "ESPN feed contained no valid stories mentioning the requested team names.",
      provider: "ESPN", sourceUrl: ESPN_SOCCER_FEED, observedAt, staleAfterHours: 24,
      teams: requestedTeams, contentIsUntrusted: true, items,
    });
  } catch (error) {
    const reason = error instanceof Error && error.message === "response_too_large"
      ? "ESPN feed exceeded the 256 KB limit."
      : error instanceof DOMException && error.name === "TimeoutError"
        ? "ESPN feed request timed out."
        : "ESPN feed request or parsing failed.";
    return soccerNewsOutputSchema.parse({
      availability: "UNAVAILABLE", reason, provider: "ESPN", sourceUrl: ESPN_SOCCER_FEED,
      observedAt, staleAfterHours: 24, teams: requestedTeams, contentIsUntrusted: true, items: [],
    });
  }
}

async function getSoccerResearch(input: {
  league: SoccerLeague; date?: string; days: number; fixtureId?: string; limit: number;
}): Promise<z.infer<typeof soccerResearchOutputSchema>> {
  const definition = SPORTS_COMPETITIONS[input.league];
  const startDate = input.date ?? new Date().toISOString().slice(0, 10);
  const endDate = addDays(startDate, input.days);
  const observedAt = new Date().toISOString();
  const fixturesUrl = input.fixtureId
    ? footballDataUrl(`matches/${input.fixtureId}`)
    : footballDataUrl(`competitions/${input.league}/matches`, { dateFrom: startDate, dateTo: endDate });
  const fixturesResponse = await getProviderJson(fixturesUrl);
  const sources: z.infer<typeof soccerSourceSchema>[] = [{
    provider: "football-data.org", purpose: input.fixtureId ? "EXACT_FIXTURE" : "FIXTURES_AND_RESULTS",
    url: fixturesUrl, observedAt: new Date().toISOString(),
  }];
  const unavailable = (reason: string, season: string | null = null) => soccerResearchOutputSchema.parse({
    availability: "UNAVAILABLE", reason, league: input.league, competition: definition.name,
    provider: "football-data.org", sources, observedAt, season, leagueProviderId: input.league,
    coverage: "UNAVAILABLE", returnedEventCount: 0, fixtures: [],
  });
  if (!fixturesResponse.ok) return unavailable(fixturesResponse.reason);

  let matches: z.infer<typeof footballDataMatchSchema>[];
  if (input.fixtureId) {
    const parsed = footballDataMatchSchema.safeParse(fixturesResponse.data);
    matches = parsed.success && String(parsed.data.id) === input.fixtureId ? [parsed.data] : [];
  } else {
    const parsed = footballDataMatchesSchema.safeParse(fixturesResponse.data);
    matches = parsed.success ? parsed.data.matches : [];
  }
  matches = matches.filter((match) => match.competition?.code === input.league);
  if (!input.fixtureId) matches = matches.filter((match) => match.utcDate.slice(0, 10) >= startDate && match.utcDate.slice(0, 10) <= endDate);
  if (matches.length === 0) return unavailable("football-data.org returned no verified fixtures or results for this competition and date window.");

  const exactMatch = input.fixtureId ? matches[0] : undefined;
  let homeRecentResults: z.infer<typeof soccerObservedResultSchema>[] = [];
  let awayRecentResults: z.infer<typeof soccerObservedResultSchema>[] = [];
  let formReason: string | null = "Select one exact fixture to request the teams' last five completed league results.";
  let homeFormReason: string | null = formReason;
  let awayFormReason: string | null = formReason;
  if (exactMatch) {
    const teamRequests = [exactMatch.homeTeam, exactMatch.awayTeam].map((team) => {
      const url = footballDataUrl(`teams/${team.id}/matches`, {
        competitions: definition.competitionId, status: "FINISHED", limit: "100",
      });
      return { url, team, request: getProviderJson(url) };
    });
    const teamResponses = await Promise.all(teamRequests.map((request) => request.request));
    for (const [index, response] of teamResponses.entries()) {
      const request = teamRequests[index];
      if (!request) continue;
      let teamReason: string | null = null;
      let recentResults: z.infer<typeof soccerObservedResultSchema>[] = [];
      if (!response.ok) {
        teamReason = response.reason;
      } else {
        const parsed = footballDataMatchesSchema.safeParse(response.data);
        if (!parsed.success) {
          teamReason = "football-data.org returned an unexpected recent-results shape.";
        } else {
          recentResults = parsed.data.matches
            .filter((match) => match.competition?.id === Number(definition.competitionId)
              && match.status === "FINISHED" && Date.parse(match.utcDate) < Date.parse(exactMatch.utcDate))
            .sort((left, right) => Date.parse(right.utcDate) - Date.parse(left.utcDate))
            .map((match) => mapFootballResult(match, request.team.id))
            .filter((result): result is z.infer<typeof soccerObservedResultSchema> => result !== null)
            .slice(0, 5);
          if (recentResults.length === 0) {
            teamReason = `football-data.org returned no completed ${input.league} results for ${request.team.name}.`;
          } else if (recentResults.length < 5) {
            teamReason = `football-data.org returned ${recentResults.length} completed ${input.league} results for ${request.team.name}.`;
          }
        }
      }
      sources.push({
        provider: "football-data.org", purpose: "TEAM_FORM", url: request.url, observedAt: new Date().toISOString(),
        teamProviderId: String(request.team.id), teamName: request.team.name,
        availability: recentResults.length > 0 ? "AVAILABLE" : "UNAVAILABLE",
        returnedResultCount: response.ok ? recentResults.length : null, reason: teamReason,
      });
      if (index === 0) {
        homeRecentResults = recentResults;
        homeFormReason = teamReason;
      } else {
        awayRecentResults = recentResults;
        awayFormReason = teamReason;
      }
    }
    const incompleteTeams = [
      { name: exactMatch.homeTeam.name, count: homeRecentResults.length, reason: homeFormReason },
      { name: exactMatch.awayTeam.name, count: awayRecentResults.length, reason: awayFormReason },
    ].filter((team) => team.count < 5)
      .map((team) => `${team.name} (${team.count}/5 results): ${team.reason ?? "fewer than five completed results were returned."}`);
    if (incompleteTeams.length === 0) formReason = null;
    else if (homeRecentResults.length + awayRecentResults.length === 0) {
      formReason = `Form unavailable: ${incompleteTeams.join("; ")}`;
    } else {
      formReason = `Partial form: ${incompleteTeams.join("; ")}`;
    }
  }
  const fixtures = matches
    .sort((left, right) => left.utcDate.localeCompare(right.utcDate) || left.id - right.id)
    .slice(0, input.limit)
    .map((match) => mapFootballFixture(match, input.league,
      match.id === exactMatch?.id ? homeRecentResults : [],
      match.id === exactMatch?.id ? awayRecentResults : [],
      match.id === exactMatch?.id ? formReason : "Select one exact fixture to request the teams' last five completed league results.",
      match.id === exactMatch?.id ? homeFormReason : "Select one exact fixture to request this team's last five completed league results.",
      match.id === exactMatch?.id ? awayFormReason : "Select one exact fixture to request this team's last five completed league results.",
    ))
    .filter((fixture): fixture is z.infer<typeof soccerFixtureSchema> => fixture !== null);
  if (fixtures.length === 0) return unavailable("football-data.org response did not match the requested competition schema.");
  return soccerResearchOutputSchema.parse({
    availability: "AVAILABLE", reason: null, league: input.league, competition: definition.name,
    provider: "football-data.org", sources, observedAt, season: null,
    leagueProviderId: input.league, coverage: "RETURNED_MATCHES", returnedEventCount: matches.length, fixtures,
  });
}

function toUnits(value: string, decimals: number, maxInputDecimals = decimals): bigint {
  if (value.length > 128 || !/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    throw new Error("PS_AMOUNT_INVALID: Use a nonnegative decimal string without exponent notation.");
  }
  const parts = value.split(".");
  const whole = parts[0] ?? "0";
  const fraction = parts[1] ?? "";
  if (fraction.length > maxInputDecimals || fraction.length > decimals) {
    throw new Error(`PS_AMOUNT_PRECISION: Amount supports at most ${maxInputDecimals} decimal places.`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

function address(value: string): Address {
  return getAddress(value);
}

function signatureHex(value: string): Hex {
  return `0x${value.slice(2)}`;
}

function clobAuthTypedData(signer: Address, timestamp: string, nonce: string) {
  return {
    domain: { name: "ClobAuthDomain", version: "1", chainId: 137 },
    types: {
      ClobAuth: [
        { name: "address", type: "address" },
        { name: "timestamp", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "message", type: "string" },
      ],
    },
    primaryType: "ClobAuth",
    message: {
      address: signer,
      timestamp,
      nonce: BigInt(nonce),
      message: "This message attests that I control the given wallet",
    },
  } as const;
}

function signatureType(type: z.infer<typeof walletTypeSchema>): 0 | 1 | 2 | 3 {
  switch (type) {
    case "EOA": return 0;
    case "PROXY": return 1;
    case "SAFE": return 2;
    case "DEPOSIT_WALLET": return 3;
  }
}

function orderMessage(prepared: PreparedOrderBase) {
  const { wallet, order } = prepared;
  return {
    salt: BigInt(order.salt),
    maker: address(wallet.makerAddress),
    signer: address(wallet.orderSignerAddress),
    tokenId: BigInt(order.assetId),
    makerAmount: BigInt(order.makerAmount),
    takerAmount: BigInt(order.takerAmount),
    side: order.side === "BUY" ? 0 : 1,
    signatureType: wallet.signatureType,
    timestamp: BigInt(order.timestamp),
    metadata: ZERO32,
    builder: ZERO32,
  } as const;
}

function orderDomain(prepared: PreparedOrderBase) {
  return prepared.market.version === "v2"
    ? { name: "Polymarket CTF Exchange", version: "3", chainId: 137, verifyingContract: address(DOMAIN_BY_MARKET.v2.verifyingContract) }
    : {
        name: "Polymarket CTF Exchange",
        version: "2",
        chainId: 137,
        verifyingContract: address(prepared.market.negRisk ? DOMAIN_BY_MARKET.ctf.negRisk.verifyingContract : DOMAIN_BY_MARKET.ctf.regular.verifyingContract),
      };
}

function depositOrderPayload(prepared: PreparedOrderBase) {
  return {
    domain: orderDomain(prepared),
    types: { Order: ORDER_FIELDS, TypedDataSign: TYPED_DATA_SIGN_FIELDS },
    primaryType: "TypedDataSign",
    message: {
      contents: orderMessage(prepared),
      name: "DepositWallet",
      version: "1",
      chainId: 137n,
      verifyingContract: address(prepared.wallet.makerAddress),
      salt: ZERO32,
    },
  } as const;
}

function standardOrderPayload(prepared: PreparedOrderBase) {
  return {
    domain: orderDomain(prepared),
    types: { Order: ORDER_FIELDS },
    primaryType: "Order",
    message: orderMessage(prepared),
  } as const;
}

function signingPayload(prepared: PreparedOrderBase) {
  return prepared.wallet.type === "DEPOSIT_WALLET"
    ? depositOrderPayload(prepared)
    : standardOrderPayload(prepared);
}

function wireTypedData(payload: unknown): TypedPayload {
  const serialized: unknown = JSON.parse(JSON.stringify(payload, (_key: string, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  ));
  return typedDataSchema.parse(serialized);
}

function wrapDepositWalletSignature(prepared: PreparedOrder, signature: Hex): Hex {
  const order = prepared.order;
  const exchangeDomain = orderDomain(prepared);
  const verifyingContract = exchangeDomain.verifyingContract;
  const appDomainSeparator = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [
      keccak256(toHex(EIP712_DOMAIN_TYPE)),
      keccak256(toHex(exchangeDomain.name)),
      keccak256(toHex(exchangeDomain.version)),
      BigInt(exchangeDomain.chainId),
      verifyingContract,
    ],
  ));
  const contentsHash = keccak256(encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" },
      { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint8" },
      { type: "uint8" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" },
    ],
    [
      keccak256(toHex(ORDER_TYPE)), BigInt(order.salt), address(prepared.wallet.makerAddress),
      address(prepared.wallet.orderSignerAddress), BigInt(order.assetId), BigInt(order.makerAmount),
      BigInt(order.takerAmount), order.side === "BUY" ? 0 : 1, prepared.wallet.signatureType,
      BigInt(order.timestamp), ZERO32, ZERO32,
    ],
  ));
  return concatHex([
    signature,
    appDomainSeparator,
    contentsHash,
    toHex(ORDER_TYPE),
    toHex(ORDER_TYPE.length, { size: 2 }),
  ]);
}

const MICRO = 1_000_000n;

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function feeMicros(sizeMicros: bigint, priceMicros: bigint, feeRateMicros: bigint, feeExponent: number): bigint {
  if (feeRateMicros === 0n) return 0n;
  const priceFactor = priceMicros * (MICRO - priceMicros);
  let numerator = sizeMicros * feeRateMicros;
  let denominator = MICRO;
  for (let index = 0; index < feeExponent; index += 1) {
    numerator *= priceFactor;
    denominator *= MICRO * MICRO;
  }
  return ceilDiv(numerator, denominator);
}

function marketFeeInfo(value: unknown): { rate: string; exponent: number } {
  const parsed = clobMarketInfoSchema.safeParse(value);
  if (!parsed.success) throw new Error("PS_FEE_INVALID: Polymarket market fee metadata is invalid.");
  const descriptor = parsed.data.fd;
  if (descriptor == null) return { rate: "0", exponent: 0 };
  const rate = String(descriptor.r);
  try { toUnits(rate, 6, 6); }
  catch { throw new Error("PS_FEE_INVALID: Polymarket fee rate exceeds supported decimal precision."); }
  return { rate, exponent: descriptor.e };
}

function bookAgeMs(timestamp: string | null | undefined, now = Date.now()): number | null {
  if (timestamp == null) return null;
  const raw = Number(timestamp);
  const timestampMs = Number.isSafeInteger(raw) && raw > 0 ? raw >= 100_000_000_000 ? raw : raw * 1000 : Number.NaN;
  return Number.isSafeInteger(timestampMs) && timestampMs <= now ? now - timestampMs : null;
}

async function validateWalletSignature(prepared: PreparedOrder, signature: Hex) {
  const expected = address(prepared.wallet.signingAddress);
  let recovered: Address | null = null;
  try {
    recovered = prepared.wallet.type === "DEPOSIT_WALLET"
      ? await recoverTypedDataAddress({ ...depositOrderPayload(prepared), signature })
      : await recoverTypedDataAddress({ ...standardOrderPayload(prepared), signature });
  } catch { recovered = null; }
  if (recovered?.toLowerCase() !== expected.toLowerCase()) {
    return { valid: false, recovered, encoding: prepared.wallet.type === "DEPOSIT_WALLET" ? "ERC-7739" as const : "EIP-712" as const, contractWalletAcceptance: prepared.wallet.type === "EOA" ? "NOT_APPLICABLE" as const : "DEFERRED_TO_CLOB" as const, signedSignature: null };
  }
  const signedSignature = prepared.wallet.type === "DEPOSIT_WALLET" ? wrapDepositWalletSignature(prepared, signature) : signature;
  if (prepared.wallet.type === "EOA") {
    return { valid: true, recovered, encoding: "EIP-712" as const, contractWalletAcceptance: "NOT_APPLICABLE" as const, signedSignature };
  }
  return { valid: true, recovered, encoding: prepared.wallet.type === "DEPOSIT_WALLET" ? "ERC-7739" as const : "EIP-712" as const, contractWalletAcceptance: "DEFERRED_TO_CLOB" as const, signedSignature };
}

type ClobCredentials = z.infer<typeof clobCredentialSchema>;

function l1Headers(auth: z.infer<typeof clobAuthSchema>, signerAddress: string) {
  return {
    POLY_ADDRESS: signerAddress,
    POLY_SIGNATURE: auth.signature,
    POLY_TIMESTAMP: auth.timestamp,
    POLY_NONCE: auth.nonce,
  };
}

async function deriveClobCredentials(
  authInput: z.infer<typeof clobAuthSchema>, signerAddress: string, createOnMissing = false,
): Promise<ClobCredentials> {
  const auth = clobAuthSchema.parse(authInput);
  const signer = address(signerAddress);
  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      ...clobAuthTypedData(signer, auth.timestamp, auth.nonce), signature: signatureHex(auth.signature),
    });
  } catch { throw new Error("PS_AUTH_SIGNATURE_INVALID: ClobAuth signature could not be recovered."); }
  if (recovered.toLowerCase() !== signer.toLowerCase()) throw new Error("PS_AUTH_WALLET_MISMATCH: ClobAuth signer differs from the selected order signer.");

  const read = async (path: "/auth/derive-api-key" | "/auth/api-key", method: "GET" | "POST") => {
    const response = await fetch(`${CLOB_API}${path}`, {
      method, headers: { accept: "application/json", ...l1Headers(auth, signer) },
      redirect: "error", signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return { status: response.status, data: null };
    const data: unknown = JSON.parse(await boundedResponseText(response, 32_768));
    return { status: response.status, data };
  };
  let result = await read("/auth/derive-api-key", "GET");
  if (result.status === 404 && createOnMissing) result = await read("/auth/api-key", "POST");
  if (result.status < 200 || result.status >= 300 || result.data === null) {
    throw new Error(`PS_CLOB_AUTH_FAILED: Polymarket CLOB credential derivation failed with HTTP ${result.status}.`);
  }
  const parsed = clobCredentialSchema.safeParse(result.data);
  if (!parsed.success) throw new Error("PS_CLOB_AUTH_INVALID: Polymarket returned an invalid credential response.");
  return parsed.data;
}

function l2Signature(secret: string, timestamp: string, method: string, path: string, body = ""): string {
  const key = Buffer.from(secret.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return createHmac("sha256", key).update(`${timestamp}${method}${path}${body}`).digest("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

async function clobPrivateRequest(
  credentials: ClobCredentials, signerAddress: string, method: "GET" | "POST" | "DELETE",
  path: string, body?: string, signingPath = path,
): Promise<{ status: number; data: unknown | null }> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = l2Signature(credentials.secret, timestamp, method, signingPath, body ?? "");
  const response = await fetch(`${CLOB_API}${path}`, {
    method,
    headers: {
      accept: "application/json", "content-type": "application/json",
      POLY_ADDRESS: signerAddress, POLY_API_KEY: credentials.apiKey, POLY_PASSPHRASE: credentials.passphrase,
      POLY_SIGNATURE: signature, POLY_TIMESTAMP: timestamp,
    },
    ...(body === undefined ? {} : { body }), redirect: "error", signal: AbortSignal.timeout(1_500),
  });
  if (response.status === 204 || response.status === 404) return { status: response.status, data: null };
  const text = await boundedResponseText(response, 1_000_000);
  let data: unknown;
  try { data = JSON.parse(text) as unknown; }
  catch { return { status: response.status, data: null }; }
  return { status: response.status, data };
}

async function validateExecutionSnapshot(prepared: PreparedOrder): Promise<{
  market: z.infer<typeof gammaMarketSchema>; book: z.infer<typeof bookSchema>;
  feeRate: string; feeExponent: number; blocked: boolean;
}> {
  const { market: approvedMarket, order } = prepared;
  const bookUrl = new URL(`${CLOB_API}/book`);
  bookUrl.searchParams.set("token_id", order.assetId);
  const [rawMarket, rawBook, rawMarketInfo, rawGeo] = await Promise.all([
    getJson(`${GAMMA_API}/markets/${encodeURIComponent(approvedMarket.id)}`),
    getJson(bookUrl.toString()), getJson(`${CLOB_API}/clob-markets/${encodeURIComponent(approvedMarket.conditionId)}`), getJson(GEOBLOCK_API),
  ]);
  const market = gammaMarketSchema.parse(rawMarket);
  const book = bookSchema.parse(rawBook);
  const feeInfo = marketFeeInfo(rawMarketInfo);
  const geo = geoblockSchema.parse(rawGeo);
  const outcome = marketOutcomeAssets(market)?.find((item) => item.assetId === order.assetId);
  if (String(market.id) !== approvedMarket.id || market.conditionId?.toLowerCase() !== approvedMarket.conditionId.toLowerCase() || outcome?.name !== approvedMarket.outcome || book.asset_id !== order.assetId || book.market.toLowerCase() !== approvedMarket.conditionId.toLowerCase()) {
    throw new Error("PS_MARKET_IDENTITY: Refreshed market and order book no longer match the signed market outcome.");
  }
  if (market.active !== true || market.closed !== false || market.acceptingOrders !== true || market.enableOrderBook === false) {
    throw new Error("PS_MARKET_CLOSED: Refreshed market is not accepting this order.");
  }
  const currentVersion = book.version ?? "v1";
  if (currentVersion !== approvedMarket.version || book.neg_risk !== approvedMarket.negRisk) {
    throw new Error("PS_MARKET_CHANGED: Exchange version or risk mode changed after preparation.");
  }
  if (market.negRisk !== undefined && market.negRisk !== book.neg_risk) {
    throw new Error("PS_MARKET_VERSION: Refreshed Gamma market and CLOB book disagree about the negative-risk exchange.");
  }
  if (market.version != null && book.version != null && market.version !== book.version) {
    throw new Error("PS_MARKET_VERSION: Refreshed Gamma market and CLOB book versions disagree.");
  }
  const currentPriceUnits = toUnits(order.price, 6);
  if (currentPriceUnits <= 0n || currentPriceUnits >= MICRO || currentPriceUnits % toUnits(book.tick_size, 6) !== 0n) {
    throw new Error("PS_PRICE_INVALID: Signed order price does not match the current tick size.");
  }
  const currentMinimumUnits = toUnits(book.min_order_size, 6);
  if (currentMinimumUnits <= 0n) throw new Error("PS_PROVIDER_INVALID: CLOB returned a nonpositive current minimum order size.");
  if (toUnits(order.size, 6, 2) < currentMinimumUnits) {
    throw new Error("PS_SIZE_BELOW_MINIMUM: Signed order size is below the current market minimum.");
  }
  const limitPriceUnits = toUnits(order.price, 6);
  const feePriceUnits = order.side === "BUY"
    ? limitPriceUnits < MICRO / 2n ? limitPriceUnits : MICRO / 2n
    : limitPriceUnits > MICRO / 2n ? limitPriceUnits : MICRO / 2n;
  const currentFeeUnits = feeMicros(toUnits(order.size, 6), feePriceUnits, toUnits(feeInfo.rate, 6), feeInfo.exponent);
  if (toUnits(order.maxGrossPusd, 6) + currentFeeUnits > toUnits(order.maxNominalPusd, 6)) {
    throw new Error("PS_SPENDING_CAP: Current Polymarket fees would exceed the user-approved all-in spending cap.");
  }
  return { market, book, feeRate: feeInfo.rate, feeExponent: feeInfo.exponent, blocked: geo.blocked };
}

function mapOrderStatus(status: string | undefined, matched: string | undefined, original: string | undefined) {
  const normalized = status?.toUpperCase();
  if (matched !== undefined && original !== undefined) {
    try {
      const matchedUnits = toUnits(matched, 6);
      const originalUnits = toUnits(original, 6);
      if (matchedUnits > 0n) return matchedUnits >= originalUnits ? "FILLED" as const : "PARTIALLY_FILLED" as const;
    } catch { return "UNKNOWN" as const; }
  }
  if (normalized === "CANCELLED" || normalized === "CANCELED") return "CANCELLED" as const;
  if (normalized === "FAILED" || normalized === "REJECTED") return "FAILED" as const;
  if (normalized === "LIVE" || normalized === "DELAYED" || normalized === "OPEN") return "OPEN" as const;
  if (normalized === "MATCHED" && matched === undefined) return "SUBMITTED" as const;
  return normalized === "MATCHED" ? "UNKNOWN" as const : "UNKNOWN" as const;
}

function orderStatusResult(input: {
  orderId: string; requestedSize: string; record: unknown;
}): z.infer<typeof executionResultSchema> | null {
  const parsed = orderReadSchema.safeParse(input.record);
  if (!parsed.success) return null;
  const record = parsed.data;
  const original = record.original_size ?? input.requestedSize;
  const matched = record.size_matched;
  const status = mapOrderStatus(record.status, matched, original);
  const filledSize = matched === undefined ? null : matched;
  let remainingSize: string | null = null;
  if (matched !== undefined) {
    try {
      const remaining = toUnits(original, 6) - toUnits(matched, 6);
      remainingSize = remaining >= 0n ? formatUnits(remaining, 6) : null;
    } catch { remainingSize = null; }
  }
  return executionResultSchema.parse({
    status, orderId: input.orderId, orderType: FAK,
    requestedSize: input.requestedSize, filledSize, remainingSize,
    tradeIds: record.associate_trades ?? [],
    message: status === "FILLED" ? "Order status read-back reports the requested size filled."
      : status === "PARTIALLY_FILLED" ? "Order status read-back reports a partial fill; the FAK remainder does not rest."
        : status === "OPEN" ? "Order status read-back reports an open order; inspect or cancel it explicitly."
          : `Polymarket order status: ${status}.`,
  });
}

function validatePreparedOrder(prepared: PreparedOrder): {
  priceUnits: bigint; sizeUnits: bigint; quoteUnits: bigint; capUnits: bigint; feeRateMicros: bigint; feeExponent: number;
} {
  const order = prepared.order;
  const rules = TICK_RULES[prepared.market.tickSize];
  const priceUnits = toUnits(order.price, 6, rules.priceDecimals);
  const sizeUnits = toUnits(order.size, 6, 2);
  const capUnits = toUnits(order.maxNominalPusd, 6, 6);
  const quoteUnits = priceUnits * sizeUnits / MICRO;
  const feeRateMicros = toUnits(order.feeRate, 6, 6);
  const feeExponent = order.feeExponent;
  const feePriceUnits = order.side === "BUY"
    ? priceUnits < MICRO / 2n ? priceUnits : MICRO / 2n
    : priceUnits > MICRO / 2n ? priceUnits : MICRO / 2n;
  const maxFeeUnits = feeMicros(sizeUnits, feePriceUnits, feeRateMicros, feeExponent);
  const expectedMakerAmount = (order.side === "BUY" ? quoteUnits : sizeUnits).toString();
  const expectedTakerAmount = (order.side === "BUY" ? sizeUnits : quoteUnits).toString();
  const amountPrecision = 10n ** BigInt(6 - rules.amountDecimals);
  const timestamp = Number(order.timestamp);

  if (BigInt(order.salt) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("PS_ORDER_INVALID: Order salt exceeds the exact integer range of the CLOB JSON format.");
  }
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error("PS_ORDER_INVALID: Prepared order timestamp is invalid.");
  }
  if (priceUnits <= 0n || priceUnits >= MICRO || priceUnits % toUnits(prepared.market.tickSize, 6) !== 0n) {
    throw new Error("PS_PRICE_INVALID: Prepared order price does not match its tick size.");
  }
  if (sizeUnits < toUnits(prepared.market.minOrderSize, 6) || sizeUnits <= 0n || capUnits <= 0n || feeRateMicros > MICRO) {
    throw new Error("PS_ORDER_INVALID: Prepared order size, nominal cap, or fee rate is invalid.");
  }
  if (quoteUnits % amountPrecision !== 0n || priceUnits * sizeUnits % MICRO !== 0n) {
    throw new Error("PS_AMOUNT_PRECISION: Prepared order amounts exceed Polymarket precision.");
  }
  if (quoteUnits + maxFeeUnits > capUnits || order.maxGrossPusd !== formatUnits(quoteUnits, 6) || order.maxFeePusd !== formatUnits(maxFeeUnits, 6)) {
    throw new Error("PS_SPENDING_CAP: Fee-inclusive order value exceeds or differs from the user-approved maximum.");
  }
  if (order.makerAmount !== expectedMakerAmount || order.takerAmount !== expectedTakerAmount || order.metadata !== ZERO32 || order.builder !== ZERO32) {
    throw new Error("PS_ORDER_INVALID: Signed amounts or fixed order metadata do not match the approved price and size.");
  }
  if (prepared.wallet.signatureType !== signatureType(prepared.wallet.type)) {
    throw new Error("PS_WALLET_BINDING: Wallet type and Polymarket signature type do not match.");
  }
  const expectedOrderSigner = prepared.wallet.type === "DEPOSIT_WALLET" ? prepared.wallet.makerAddress : prepared.wallet.signingAddress;
  if (prepared.wallet.orderSignerAddress.toLowerCase() !== expectedOrderSigner.toLowerCase()) {
    throw new Error("PS_WALLET_BINDING: Order signer does not match the selected wallet type.");
  }
  if (prepared.wallet.type === "EOA" && prepared.wallet.makerAddress.toLowerCase() !== prepared.wallet.signingAddress.toLowerCase()) {
    throw new Error("PS_WALLET_BINDING: EOA maker and signing addresses must match.");
  }
  return { priceUnits, sizeUnits, quoteUnits, capUnits, feeRateMicros, feeExponent };
}

function tradeToolResult(value: unknown) {
  const result = executionResultSchema.parse(value);
  return { content: [{ type: "text" as const, text: result.message }], structuredContent: result };
}

function stableErrorCode(error: unknown, fallback: string): string {
  const match = error instanceof Error ? /^(PS_[A-Z_]+)/.exec(error.message) : null;
  return match?.[1] ?? fallback;
}

async function createServer() {
  const server = new McpServer(
    { name: "polyscope", version: "0.1.0" },
    { supportedProtocolVersions: [PROTOCOL_VERSION] },
  );

  server.registerTool(
    "search_markets",
    {
      title: "Search Polymarket markets",
      description: "Find active Polymarket markets and map every listed outcome to its public CLOB asset ID. Returns resolution details and observed public market data.",
      inputSchema: z.object({ query: z.string().min(2).max(100), limit: z.number().int().min(1).max(5).default(3) }).strict(),
      outputSchema: z.object({ markets: z.array(marketResultSchema), resultCount: z.number().int() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, limit }) => {
      const url = new URL(`${GAMMA_API}/public-search`);
      url.searchParams.set("q", query);
      url.searchParams.set("events_status", "active");
      url.searchParams.set("limit_per_type", String(limit));
      url.searchParams.set("cache", "false");
      const response = searchResponseSchema.parse(await getJson(url.toString()));
      const markets: z.infer<typeof marketResultSchema>[] = [];
      const observedAt = new Date().toISOString();
      for (const event of response.events.slice(0, limit)) {
        for (const market of event.markets) {
          if (market.active !== true || market.closed !== false || market.enableOrderBook === false) continue;
          if (!market.conditionId || !market.question || market.negRisk === undefined) continue;
          const mappedOutcomes = marketOutcomeAssets(market);
          if (!mappedOutcomes) continue;
          const yesOutcome = mappedOutcomes.find((item) => item.name.toLowerCase() === "yes");
          const noOutcome = mappedOutcomes.find((item) => item.name.toLowerCase() === "no");
          const result = marketResultSchema.parse({
            eventTitle: event.title ?? market.question,
            marketId: String(market.id),
            question: market.question,
            slug: market.slug ?? null,
            conditionId: market.conditionId,
            version: market.version ?? null,
            negRisk: market.negRisk,
            acceptingOrders: market.acceptingOrders ?? null,
            endDate: market.endDate ?? null,
            resolutionRules: market.description ?? null,
            resolutionSource: market.resolutionSource ?? null,
            volume: market.volume ?? null,
            volume24h: market.volume24hr ?? null,
            liquidity: market.liquidity ?? null,
            outcomes: mappedOutcomes,
            yesAssetId: yesOutcome?.assetId ?? null,
            noAssetId: noOutcome?.assetId ?? null,
            observedAt,
          });
          markets.push(result);
          if (markets.length >= 20) break;
        }
        if (markets.length >= 20) break;
      }
      return {
        content: [{ type: "text", text: `Found ${markets.length} active markets with mapped outcome identifiers.` }],
        structuredContent: { markets, resultCount: markets.length },
      };
    },
  );

  server.registerTool(
    "get_quote",
    {
      title: "Read a Polymarket order book quote",
      description: "Reads the public CLOB book and current fee rate for one market outcome and estimates visible BUY/SELL fill, average price, gross amount, and fee. No order is created. Quotes older than 30 seconds are marked stale; refresh before any later signing step.",
      inputSchema: z.object({
        marketId: z.string().regex(/^[0-9]{1,32}$/), assetId: decimalIdSchema, side: sideSchema,
        size: z.string().max(32).optional(), depth: z.number().int().min(1).max(20).default(10),
      }).strict(),
      outputSchema: quoteResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ marketId, assetId, side, size, depth }) => {
      const marketUrl = `${GAMMA_API}/markets/${encodeURIComponent(marketId)}`;
      const bookUrl = new URL(`${CLOB_API}/book`);
      bookUrl.searchParams.set("token_id", assetId);
      const [rawMarket, rawBook] = await Promise.all([getJson(marketUrl), getJson(bookUrl.toString())]);
      const market = gammaMarketSchema.parse(rawMarket);
      const book = bookSchema.parse(rawBook);
      if (String(market.id) !== marketId || market.active !== true || market.closed !== false) {
        throw new Error("PS_MARKET_CLOSED: The selected market is not active.");
      }
      if (!market.question) throw new Error("PS_PROVIDER_INVALID: The selected market has no question text.");
      if (!market.conditionId || book.asset_id !== assetId || book.market.toLowerCase() !== market.conditionId.toLowerCase()) {
        throw new Error("PS_MARKET_IDENTITY: CLOB book identity does not match the selected market and outcome.");
      }
      const feeInfo = marketFeeInfo(await getJson(`${CLOB_API}/clob-markets/${encodeURIComponent(market.conditionId)}`));
      const mappedOutcomes = marketOutcomeAssets(market);
      const selectedOutcome = mappedOutcomes?.find((outcome) => outcome.assetId === assetId);
      if (!selectedOutcome) throw new Error("PS_MARKET_IDENTITY: The asset ID is not mapped to an outcome in this market.");
      if (market.negRisk !== undefined && market.negRisk !== book.neg_risk) {
        throw new Error("PS_MARKET_VERSION: Market and CLOB book disagree about the negative-risk exchange.");
      }
      if (book.version && market.version && book.version !== market.version) {
        throw new Error("PS_MARKET_VERSION: Gamma market and CLOB book protocol versions do not match.");
      }

      const toLevels = (entries: Array<{ price: string; size: string }>) => entries.map((entry) => {
        const priceUnits = toUnits(entry.price, 6);
        const sizeUnits = toUnits(entry.size, 6);
        if (priceUnits <= 0n || priceUnits >= 1_000_000n || sizeUnits <= 0n) throw new Error("PS_PROVIDER_INVALID: CLOB returned an invalid price or size level.");
        return { priceUnits, sizeUnits };
      });
      const bids = toLevels(book.bids).sort((left, right) => left.priceUnits === right.priceUnits ? 0 : left.priceUnits > right.priceUnits ? -1 : 1);
      const asks = toLevels(book.asks).sort((left, right) => left.priceUnits === right.priceUnits ? 0 : left.priceUnits < right.priceUnits ? -1 : 1);
      const visibleLevels = side === "BUY" ? asks : bids;
      const totalAvailable = visibleLevels.reduce((total, level) => total + level.sizeUnits, 0n);
      const requestedUnits = size === undefined ? null : toUnits(size, 6, 6);
      if (requestedUnits !== null && requestedUnits <= 0n) throw new Error("PS_SIZE_INVALID: Quote size must be greater than zero shares.");
      let filledUnits = 0n;
      let unfilledUnits = requestedUnits ?? 0n;
      let quoteScaled12 = 0n;
      let estimatedFeeUnits = 0n;
      let worstPriceUnits: bigint | null = null;
      if (requestedUnits !== null) {
        for (const level of visibleLevels) {
          if (unfilledUnits === 0n) break;
          const take = level.sizeUnits < unfilledUnits ? level.sizeUnits : unfilledUnits;
          filledUnits += take;
          unfilledUnits -= take;
          quoteScaled12 += take * level.priceUnits;
          estimatedFeeUnits += feeMicros(take, level.priceUnits, toUnits(feeInfo.rate, 6), feeInfo.exponent);
          worstPriceUnits = level.priceUnits;
        }
      }
      const now = Date.now();
      const rawTimestamp = Number(book.timestamp);
      const timestampMs = Number.isSafeInteger(rawTimestamp) && rawTimestamp > 0
        ? rawTimestamp >= 100_000_000_000 ? rawTimestamp : rawTimestamp * 1000
        : Number.NaN;
      const ageMs = Number.isSafeInteger(timestampMs) && timestampMs <= now ? now - timestampMs : null;
      const observedAt = new Date(now).toISOString();
      const bestBidUnits = bids[0]?.priceUnits ?? null;
      const bestAskUnits = asks[0]?.priceUnits ?? null;
      const averagePriceUnits = filledUnits > 0n ? quoteScaled12 / filledUnits : null;
      const structuredContent = quoteResultSchema.parse({
        marketId,
        question: market.question,
        outcome: selectedOutcome.name,
        assetId,
        version: market.version ?? null,
        marketAcceptingOrders: market.acceptingOrders ?? null,
        tickSize: book.tick_size,
        minOrderSize: book.min_order_size,
        side,
        availability: visibleLevels.length > 0 ? "AVAILABLE" : "NO_LIQUIDITY",
        freshness: ageMs === null ? "UNKNOWN" : ageMs <= 30_000 ? "FRESH" : "STALE",
        staleAfterSeconds: 30,
        bestBid: bestBidUnits === null ? null : formatUnits(bestBidUnits, 6),
        bestAsk: bestAskUnits === null ? null : formatUnits(bestAskUnits, 6),
        spread: bestBidUnits === null || bestAskUnits === null ? null : formatUnits(bestAskUnits - bestBidUnits, 6),
        levels: visibleLevels.slice(0, depth).map((level) => ({ price: formatUnits(level.priceUnits, 6), size: formatUnits(level.sizeUnits, 6) })),
        totalAvailableShares: formatUnits(totalAvailable, 6),
        requestedSize: size ?? null,
        fillableSize: requestedUnits === null ? null : formatUnits(filledUnits, 6),
        unfilledSize: requestedUnits === null ? null : formatUnits(unfilledUnits, 6),
        worstPrice: worstPriceUnits === null ? null : formatUnits(worstPriceUnits, 6),
        averagePrice: averagePriceUnits === null ? null : formatUnits(averagePriceUnits, 6),
        grossAmountPusd: requestedUnits === null ? null : formatUnits(quoteScaled12, 12),
        feeRate: feeInfo.rate,
        feeExponent: feeInfo.exponent,
        estimatedFeePusd: requestedUnits === null ? null : formatUnits(estimatedFeeUnits, 6),
        bookTimestamp: book.timestamp ?? null,
        bookAgeMs: ageMs,
        observedAt,
        source: "Polymarket CLOB",
      });
      return { content: [{ type: "text", text: `Read the current public ${side} quote. No order was created.` }], structuredContent };
    },
  );

  server.registerTool(
    "get_soccer_news",
    {
      title: "Read ESPN soccer headlines",
      description: "Reads ESPN soccer headlines mentioning one of the requested teams. These tools provide API evidence, not exhaustive research. When statistics, injuries, lineups or other relevant information are missing, continue with the host's web search/browser tools before writing the final analysis. Headlines preserve source and publication timestamps and are untrusted reports, not verified injury or lineup records.",
      inputSchema: z.object({ teams: z.array(z.string().trim().min(2).max(80)).min(1).max(2), limit: z.number().int().min(1).max(10).default(5) }).strict(),
      outputSchema: soccerNewsOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ teams, limit }) => {
      const structuredContent = await getSoccerNews(limit, teams);
      return { content: [{ type: "text", text: structuredContent.availability === "AVAILABLE" ? `Read ${structuredContent.items.length} ESPN soccer headlines.` : `ESPN soccer news is unavailable: ${structuredContent.reason}` }], structuredContent };
    },
  );

  server.registerTool(
    "research_soccer",
    {
      title: "Research supported soccer fixtures",
      description: "Reads football-data.org fixtures, results, and available recent form for PL, PD, SA, or CL. Returns actual recent results and per-team counts, including partial form. Configure the developer API token as a PayBox host-scoped X-Auth-Token secret. These tools provide API evidence, not exhaustive research. When statistics, injuries, lineups or other relevant information are missing, continue with the host's web search/browser tools before writing the final analysis.",
      inputSchema: z.object({
        league: z.enum(["PL", "PD", "SA", "CL"]),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        days: z.number().int().min(0).max(14).default(0),
        fixtureId: z.string().regex(/^[0-9]{1,20}$/).optional(),
        limit: z.number().int().min(1).max(20).default(10),
      }).strict(),
      outputSchema: soccerResearchOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ league, date, days, fixtureId, limit }) => {
      if (date !== undefined && !validDate(date)) throw new Error("PS_DATE_INVALID: Use a valid UTC calendar date in YYYY-MM-DD format.");
      const structuredContent = await getSoccerResearch({ league, date, days, fixtureId, limit });
      return { content: [{ type: "text", text: structuredContent.availability === "AVAILABLE" ? `Read ${structuredContent.fixtures.length} ${structuredContent.competition} fixtures from football-data.org.` : `${structuredContent.competition} data is unavailable: ${structuredContent.reason}` }], structuredContent };
    },
  );

  server.registerTool(
    "prepare_clob_auth",
    {
      title: "Prepare Polymarket CLOB authentication signature",
      description: "Builds the Polygon ClobAuth EIP-712 payload for the existing account signer. The PayBox agent must call request_wallet_sign with the matching wallet credential and poll get_request.",
      inputSchema: z.object({ signerAddress: addressSchema, nonce: z.string().regex(/^(0|[1-9][0-9]{0,77})$/).default("0") }).strict(),
      outputSchema: typedOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ signerAddress, nonce }) => {
      if (BigInt(nonce) >= 1n << 256n) throw new Error("PS_AUTH_NONCE_INVALID: Nonce exceeds uint256.");
      const signer = address(signerAddress);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const typedData = wireTypedData(clobAuthTypedData(signer, timestamp, nonce));
      const intent = { op: "typedData" as const, typedData };
      return {
        content: [{ type: "text", text: "ClobAuth typed data prepared. Nothing was signed or sent to Polymarket." }],
        structuredContent: {
          signingAddress: signer,
          timestamp,
          nonce,
          typedData,
          requestWalletSignIntent: intent,
        },
      };
    },
  );

  server.registerTool(
    "prepare_order_signing",
    {
      title: "Prepare a bounded Polymarket BUY or SELL signature",
      description: "Prepares one unsigned FAK draft for the selected outcome, side, price bound, size, and fee-inclusive cap. Book age is returned for visibility and does not block preparation or submission. Check status: REJECTED has no order or signing intent. BUY priceLimit is the maximum; SELL priceLimit is the minimum. PayBox handles human approval and wallet signing for the Polymarket order.",
      inputSchema: z.object({
        marketId: z.string().regex(/^[0-9]{1,32}$/), assetId: decimalIdSchema,
        makerAddress: addressSchema, signingAddress: addressSchema,
        walletType: walletTypeSchema, side: sideSchema,
        priceLimit: z.string().max(32), size: z.string().max(32), maxNominalPusd: z.string().max(32),
      }).strict(),
      outputSchema: z.discriminatedUnion("status", [
        z.object({
          status: z.literal("PREPARED"),
          preparedOrder: preparedOrderSchema,
          requestWalletSignIntent: requestWalletSignIntentSchema,
          submitsOrder: z.literal(false),
          maxNominalIncludesFees: z.literal(true),
          preparationFreshness: preparationFreshnessSchema,
        }).strict(),
        z.object({
          status: z.literal("REJECTED"), errorCode: preparationErrorCodeSchema, reason: z.string(),
          submitsOrder: z.literal(false), preparationFreshness: preparationFreshnessSchema,
        }).strict(),
      ]),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ marketId, assetId, makerAddress, signingAddress, walletType, side, priceLimit, size, maxNominalPusd }) => {
      let preparationFreshness: z.infer<typeof preparationFreshnessSchema> = { bookAgeMs: null };
      try {
        const marketUrl = `${GAMMA_API}/markets/${encodeURIComponent(marketId)}`;
        const bookUrl = new URL(`${CLOB_API}/book`);
        bookUrl.searchParams.set("token_id", assetId);
        const [rawMarket, rawBook] = await Promise.all([getJson(marketUrl), getJson(bookUrl.toString())]);
        const parsedMarket = gammaMarketSchema.safeParse(rawMarket);
        const parsedBook = bookSchema.safeParse(rawBook);
        if (!parsedMarket.success || !parsedBook.success) {
          throw new Error("PS_PROVIDER_INVALID: Polymarket market or order book does not match the required schema.");
        }
        const market = parsedMarket.data;
        const book = parsedBook.data;
        preparationFreshness = { bookAgeMs: bookAgeMs(book.timestamp) };
        if (String(market.id) !== marketId) throw new Error("PS_MARKET_IDENTITY: Provider returned a different market ID.");
        if (market.active !== true || market.closed !== false) {
          throw new Error("PS_MARKET_CLOSED: The selected market is not active and tradable.");
        }
        if (market.enableOrderBook === false || market.acceptingOrders !== true || !market.conditionId) {
          throw new Error("PS_MARKET_UNSUPPORTED: The selected market is missing supported CLOB trading metadata.");
        }
        const mappedOutcomes = marketOutcomeAssets(market);
        const selectedOutcome = mappedOutcomes?.find((outcome) => outcome.assetId === assetId);
        if (!selectedOutcome) throw new Error("PS_MARKET_IDENTITY: The asset ID is not mapped to an outcome in this market.");
        if (book.asset_id !== assetId || book.market.toLowerCase() !== market.conditionId.toLowerCase()) {
          throw new Error("PS_MARKET_IDENTITY: CLOB book identity does not match the selected market and outcome.");
        }
        const feeInfo = marketFeeInfo(await getJson(`${CLOB_API}/clob-markets/${encodeURIComponent(market.conditionId)}`));
        if (market.negRisk !== undefined && market.negRisk !== book.neg_risk) {
          throw new Error("PS_MARKET_VERSION: Market and CLOB book disagree about the negative-risk exchange.");
        }
        const protocolVersion = book.version ?? "v1";
        if (market.version != null && market.version !== protocolVersion) {
          throw new Error("PS_MARKET_VERSION: Gamma and CLOB do not agree on the order-book protocol version.");
        }
        preparationFreshness.bookAgeMs = bookAgeMs(book.timestamp);
        try {
          if (toUnits(book.min_order_size, 6) <= 0n) throw new Error();
          for (const level of [...book.bids, ...book.asks]) {
            const price = toUnits(level.price, 6);
            if (price <= 0n || price >= MICRO || toUnits(level.size, 6) <= 0n) throw new Error();
          }
        } catch {
          throw new Error("PS_PROVIDER_INVALID: CLOB returned an invalid minimum size or price/size level.");
        }

        const maker = address(makerAddress);
        const signing = address(signingAddress);
        if (walletType === "EOA" && maker.toLowerCase() !== signing.toLowerCase()) {
          throw new Error("PS_WALLET_BINDING: For an EOA account, maker and signing addresses must match.");
        }
        const orderSigner = walletType === "DEPOSIT_WALLET" ? maker : signing;
        const rules = TICK_RULES[book.tick_size];
        const priceUnits = toUnits(priceLimit, 6, rules.priceDecimals);
        const sizeUnits = toUnits(size, 6, 2);
        const capUnits = toUnits(maxNominalPusd, 6, 6);
        const tickUnits = toUnits(book.tick_size, 6, rules.priceDecimals);
        const minSizeUnits = toUnits(book.min_order_size, 6, 6);
        const quoteUnits = (priceUnits * sizeUnits) / 1_000_000n;
        if (priceUnits <= 0n || priceUnits >= 1_000_000n || priceUnits % tickUnits !== 0n) {
          throw new Error(`PS_PRICE_INVALID: Price must be between 0 and 1 and conform to tick size ${book.tick_size}.`);
        }
        if (sizeUnits < minSizeUnits) throw new Error(`PS_SIZE_BELOW_MINIMUM: Size is below the market minimum of ${book.min_order_size} shares.`);
        if ((priceUnits * sizeUnits) % 1_000_000n !== 0n) throw new Error("PS_AMOUNT_PRECISION: Order amount cannot be represented at six-decimal precision.");
        if (capUnits === 0n) throw new Error("PS_SPENDING_CAP: Provide a positive nominal cap.");
        const maxGrossUnits = quoteUnits;
        const maxFeePriceUnits = side === "BUY"
          ? priceUnits < 500_000n ? priceUnits : 500_000n
          : priceUnits > 500_000n ? priceUnits : 500_000n;
        const maxFeeUnits = feeMicros(sizeUnits, maxFeePriceUnits, toUnits(feeInfo.rate, 6), feeInfo.exponent);
        if (maxGrossUnits + maxFeeUnits > capUnits) {
          throw new Error("PS_SPENDING_CAP: Fee-inclusive worst-case nominal exceeds the user-approved maximum.");
        }
        const amountPrecision = 10n ** BigInt(6 - rules.amountDecimals);
        if (quoteUnits % amountPrecision !== 0n) throw new Error(`PS_AMOUNT_PRECISION: Order quote exceeds this market's ${rules.amountDecimals}-decimal amount precision.`);
        const saltBytes = crypto.getRandomValues(new Uint8Array(8));
        const rawSalt = BigInt(bytesToHex(saltBytes));
        const salt = (rawSalt % BigInt(Number.MAX_SAFE_INTEGER)).toString();
        const timestamp = String(Date.now());
        const maxGrossPusd = formatUnits(maxGrossUnits, 6);
        const maxFeePusd = formatUnits(maxFeeUnits, 6);
        const makerAmount = (side === "BUY" ? quoteUnits : sizeUnits).toString();
        const takerAmount = (side === "BUY" ? sizeUnits : quoteUnits).toString();
        const preparedBase = preparedOrderBaseSchema.parse({
          market: {
            id: marketId, conditionId: market.conditionId, version: protocolVersion, outcome: selectedOutcome.name,
            negRisk: book.neg_risk,
            acceptingOrders: market.acceptingOrders, tickSize: book.tick_size,
            minOrderSize: book.min_order_size, bookTimestamp: book.timestamp ?? null,
          },
          wallet: {
            type: walletType, makerAddress: maker, signingAddress: signing,
            orderSignerAddress: orderSigner, signatureType: signatureType(walletType),
          },
          order: {
            salt, timestamp, assetId, side, price: priceLimit, size, maxNominalPusd,
            maxGrossPusd, maxFeePusd, feeRate: feeInfo.rate, feeExponent: feeInfo.exponent, orderType: FAK,
            makerAmount, takerAmount, metadata: ZERO32, builder: ZERO32,
          },
        });
        const typedData = wireTypedData(signingPayload(preparedBase));
        const preparedOrder = preparedOrderSchema.parse({ ...preparedBase, typedData });
        const intent = { op: "typedData" as const, typedData };
        return {
          content: [{ type: "text", text: `Prepared a bounded ${side} FAK order for PayBox approval and Polymarket signing; no order was submitted.` }],
          structuredContent: { status: "PREPARED" as const, preparedOrder, requestWalletSignIntent: intent, submitsOrder: false as const, maxNominalIncludesFees: true as const, preparationFreshness },
        };
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        const code = preparationErrorCodeSchema.safeParse(error.message.split(":", 1)[0]);
        if (!code.success) throw error;
        const reason = error.message.slice(code.data.length + 1).trim();
        return {
          content: [{ type: "text" as const, text: `Preparation rejected (${code.data}): ${reason} No order or signing intent was created.` }],
          structuredContent: { status: "REJECTED" as const, errorCode: code.data, reason, submitsOrder: false as const, preparationFreshness },
        };
      }
    },
  );

  server.registerTool(
    "validate_clob_auth_signature",
    {
      title: "Validate a PayBox ClobAuth signature",
      description: "Recovers the signer from the exact ClobAuth payload and checks it against the expected existing PayBox wallet address. This does not derive or return CLOB credentials.",
      inputSchema: z.object({
        signerAddress: addressSchema, timestamp: z.string().regex(/^[0-9]{1,16}$/),
        nonce: z.string().regex(/^(0|[1-9][0-9]{0,77})$/), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
      }).strict(),
      outputSchema: z.object({ valid: z.boolean(), expectedSignerAddress: addressSchema, recoveredSignerAddress: addressSchema.nullable() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ signerAddress, timestamp, nonce, signature }) => {
      if (BigInt(nonce) >= 1n << 256n) throw new Error("PS_AUTH_NONCE_INVALID: Nonce exceeds uint256.");
      const expected = address(signerAddress);
      let recovered: Address | null = null;
      try {
        recovered = await recoverTypedDataAddress({
          ...clobAuthTypedData(expected, timestamp, nonce),
          signature: signatureHex(signature),
        });
      } catch {
        recovered = null;
      }
      const valid = recovered?.toLowerCase() === expected.toLowerCase();
      return {
        content: [{ type: "text", text: valid ? "ClobAuth signature matches the expected signer." : "ClobAuth signature is invalid or belongs to a different signer." }],
        structuredContent: { valid, expectedSignerAddress: expected, recoveredSignerAddress: recovered },
      };
    },
  );

  server.registerTool(
    "validate_order_signature",
    {
      title: "Validate a Polymarket order signature",
      description: "Rebuilds the exact Polymarket EIP-712 order and locally verifies that its signature recovers to the selected signer. Smart-wallet contract acceptance is left to Polymarket CLOB; Deposit Wallet output includes the ERC-7739 wrapper.",
      inputSchema: z.object({ preparedOrder: preparedOrderSchema, signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).strict(),
      outputSchema: z.object({
        localSignerVerified: z.boolean(), expectedSignerAddress: addressSchema, recoveredSignerAddress: addressSchema.nullable(),
        signatureEncoding: z.enum(["EIP-712", "ERC-7739"]), signedOrderSignature: z.string().nullable(),
        contractWalletAcceptance: z.enum(["NOT_APPLICABLE", "DEFERRED_TO_CLOB"]),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ preparedOrder: parsedPrepared, signature }) => {
      const prepared = preparedOrderSchema.parse(parsedPrepared);
      const signatureValue = signatureHex(signature);
      validatePreparedOrder(prepared);
      const validation = await validateWalletSignature(prepared, signatureValue);
      const expected = address(prepared.wallet.signingAddress);
      const valid = validation.valid;
      return {
        content: [{ type: "text", text: valid ? "Order signature recovers to the selected signer locally; smart-wallet contract acceptance remains for Polymarket CLOB. No order was submitted." : "Order signature does not recover to the expected signer; no order was submitted." }],
        structuredContent: {
          localSignerVerified: valid,
          expectedSignerAddress: expected,
          recoveredSignerAddress: validation.recovered,
          signatureEncoding: validation.encoding,
          signedOrderSignature: validation.signedSignature,
          contractWalletAcceptance: validation.contractWalletAcceptance,
        },
      };
    },
  );

  server.registerTool(
    "submit_fak_order",
    {
      title: "Submit a PayBox-approved Polymarket FAK order",
      description: "Makes one signed FAK POST attempt per tool invocation after validating the Polymarket order signature, wallet binding, current market identity and exchange constraints, user price and spend bounds, and official geoblock response. Polymarket validates balance, allowance, and account constraints. Ambiguous POST results get at most one order-hash read-back and are never automatically resubmitted; this does not guarantee exactly-once execution.",
      inputSchema: z.object({
        preparedOrder: preparedOrderSchema,
        orderSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
        clobAuth: clobAuthSchema,
      }).strict(),
      outputSchema: executionResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ preparedOrder: inputOrder, orderSignature, clobAuth }) => {
      const prepared = preparedOrderSchema.parse(inputOrder);
      validatePreparedOrder(prepared);
      const orderValidation = await validateWalletSignature(prepared, signatureHex(orderSignature));
      if (!orderValidation.valid) return tradeToolResult({
        status: "REJECTED", orderId: null, orderType: FAK, requestedSize: prepared.order.size,
        filledSize: null, remainingSize: prepared.order.size, tradeIds: [],
        message: "The order signature does not recover to the approved PayBox signer; no order was sent.",
        errorCode: "PS_SIGNATURE_INVALID",
      });

      let credentials: ClobCredentials;
      let snapshot: Awaited<ReturnType<typeof validateExecutionSnapshot>>;
      try {
        [credentials, snapshot] = await Promise.all([
          deriveClobCredentials(clobAuth, prepared.wallet.signingAddress, true),
          validateExecutionSnapshot(prepared),
        ]);
        if (snapshot.blocked) {
          return tradeToolResult({
            status: "REJECTED", orderId: null, orderType: FAK, requestedSize: prepared.order.size,
            filledSize: null, remainingSize: prepared.order.size, tradeIds: [],
            message: "Polymarket geoblock reports this request as blocked; no order was sent.",
            errorCode: "PS_GEOBLOCKED",
          });
        }
      } catch (error) {
        const message = error instanceof Error && error.message.startsWith("PS_") ? error.message.split(":").slice(1).join(":").trim() : "Polymarket preflight could not be completed; no order was sent.";
        return tradeToolResult({
          status: "FAILED", orderId: null, orderType: FAK, requestedSize: prepared.order.size,
          filledSize: null, remainingSize: prepared.order.size, tradeIds: [], message,
          errorCode: stableErrorCode(error, "PS_PREFLIGHT_FAILED"),
        });
      }

      const orderHash = hashTypedData(standardOrderPayload(prepared));
      const orderBody = JSON.stringify({
        deferExec: false,
        order: {
          builder: prepared.order.builder,
          expiration: "0",
          maker: prepared.wallet.makerAddress,
          makerAmount: prepared.order.makerAmount,
          metadata: prepared.order.metadata,
          salt: Number(prepared.order.salt),
          side: prepared.order.side,
          signature: orderValidation.signedSignature,
          signatureType: prepared.wallet.signatureType,
          signer: prepared.wallet.orderSignerAddress,
          takerAmount: prepared.order.takerAmount,
          timestamp: prepared.order.timestamp,
          tokenId: prepared.order.assetId,
        },
        orderType: FAK,
        owner: credentials.apiKey,
      });
      let posted: { status: number; data: unknown | null };
      try {
        posted = await clobPrivateRequest(credentials, prepared.wallet.signingAddress, "POST", "/order", orderBody, "/order");
      } catch {
        const reconciled = await clobPrivateRequest(credentials, prepared.wallet.signingAddress, "GET", `/data/order/${orderHash}`).catch(() => null);
        const known = reconciled?.status === 200 && reconciled.data !== null
          ? orderStatusResult({ orderId: orderHash, requestedSize: prepared.order.size, record: reconciled.data }) : null;
        return tradeToolResult(known ?? {
          status: "UNKNOWN", orderId: orderHash, orderType: FAK, requestedSize: prepared.order.size,
          filledSize: null, remainingSize: null, tradeIds: [],
          message: "Order submission timed out or returned no response. Bounded read-only reconciliation did not confirm a result within this invocation; do not resubmit.",
          errorCode: "PS_SUBMISSION_UNKNOWN",
        });
      }
      const response = posted.data === null ? null : clobOrderResponseSchema.safeParse(posted.data);
      if (posted.status >= 500 || response === null || !response.success) {
        if (posted.status >= 400 && posted.status < 500 && posted.status !== 429) return tradeToolResult({
          status: "REJECTED", orderId: null, orderType: FAK, requestedSize: prepared.order.size,
          filledSize: null, remainingSize: prepared.order.size, tradeIds: [],
          message: "Polymarket rejected the FAK request; no accepted order ID was returned.",
          errorCode: "PS_CLOB_REJECTED",
        });
        const reconciled = await clobPrivateRequest(credentials, prepared.wallet.signingAddress, "GET", `/data/order/${orderHash}`).catch(() => null);
        const known = reconciled?.status === 200 && reconciled.data !== null
          ? orderStatusResult({ orderId: orderHash, requestedSize: prepared.order.size, record: reconciled.data }) : null;
        return tradeToolResult(known ?? {
          status: "UNKNOWN", orderId: orderHash, orderType: FAK, requestedSize: prepared.order.size,
          filledSize: null, remainingSize: null, tradeIds: [],
          message: "Polymarket returned an ambiguous submission result. Bounded read-only reconciliation did not confirm a result within this invocation; do not resubmit.",
          errorCode: "PS_SUBMISSION_UNKNOWN",
        });
      }
      if (response.data.success === false) return tradeToolResult({
        status: "REJECTED", orderId: null, orderType: FAK, requestedSize: prepared.order.size,
        filledSize: null, remainingSize: prepared.order.size, tradeIds: [],
        message: "Polymarket rejected the FAK order before accepting it.",
        errorCode: "PS_CLOB_REJECTED",
      });
      const orderId = response.data.orderID;
      if (posted.status < 200 || posted.status >= 300 || response.data.success !== true || !orderId) {
        const reconciled = await clobPrivateRequest(credentials, prepared.wallet.signingAddress, "GET", `/data/order/${orderHash}`).catch(() => null);
        const known = reconciled?.status === 200 && reconciled.data !== null
          ? orderStatusResult({ orderId: orderHash, requestedSize: prepared.order.size, record: reconciled.data }) : null;
        return tradeToolResult(known ?? {
          status: "UNKNOWN", orderId: orderId ?? orderHash, orderType: FAK, requestedSize: prepared.order.size,
          filledSize: null, remainingSize: null, tradeIds: response.data.tradeIDs ?? [],
          message: "The CLOB response did not confirm acceptance and fill state. Bounded read-only reconciliation did not confirm a result within this invocation; do not resubmit.",
          errorCode: "PS_SUBMISSION_UNKNOWN",
        });
      }
      return tradeToolResult({
        status: "SUBMITTED", orderId, orderType: FAK, requestedSize: prepared.order.size,
        filledSize: null, remainingSize: null, tradeIds: response.data.tradeIDs ?? [],
        message: "Polymarket accepted the FAK order. Fill state is not confirmed; call get_order_status for authenticated read-back.",
        errorCode: null,
      });
    },
  );

  server.registerTool(
    "get_order_status",
    {
      title: "Read Polymarket order status and fills",
      description: "Reads one authenticated order record and reports its matched size and trade IDs. No order is placed or retried.",
      inputSchema: z.object({ orderId: z.string().regex(/^0x[0-9a-fA-F]{64}$/), requestedSize: z.string().max(32), signerAddress: addressSchema, clobAuth: clobAuthSchema }).strict(),
      outputSchema: executionResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ orderId, requestedSize, signerAddress, clobAuth }) => {
      const credentials = await deriveClobCredentials(clobAuth, signerAddress);
      const result = await clobPrivateRequest(credentials, signerAddress, "GET", `/data/order/${encodeURIComponent(orderId)}`).catch(() => null);
      const known = result?.status === 200 && result.data !== null ? orderStatusResult({ orderId, requestedSize, record: result.data }) : null;
      return tradeToolResult(known ?? { status: "UNKNOWN", orderId, orderType: FAK, requestedSize, filledSize: null, remainingSize: null, tradeIds: [], message: "Polymarket did not return an authoritative order status.", errorCode: "PS_ORDER_STATUS_UNKNOWN" });
    },
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel an open Polymarket order",
      description: "Cancels one specified open order only after explicit confirmation. An ambiguous cancellation is reconciled once; the cancellation is never blindly retried.",
      inputSchema: z.object({ orderId: z.string().regex(/^0x[0-9a-fA-F]{64}$/), requestedSize: z.string().max(32), signerAddress: addressSchema, clobAuth: clobAuthSchema, confirmCancel: z.literal(true) }).strict(),
      outputSchema: executionResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ orderId, requestedSize, signerAddress, clobAuth }) => {
      const credentials = await deriveClobCredentials(clobAuth, signerAddress);
      const body = JSON.stringify({ orderID: orderId });
      const canceled = await clobPrivateRequest(credentials, signerAddress, "DELETE", "/order", body).catch(() => null);
      if (canceled?.status === 200 && canceled.data !== null) {
        const result = z.object({ canceled: z.array(z.string()).optional(), not_canceled: z.record(z.string(), z.string()).optional() }).passthrough().safeParse(canceled.data);
        if (result.success && result.data.canceled?.some((id) => id.toLowerCase() === orderId.toLowerCase())) return tradeToolResult({
          status: "CANCELLED", orderId, orderType: FAK, requestedSize, filledSize: null, remainingSize: null, tradeIds: [], message: "Polymarket confirmed the order cancellation.",
        });
      }
      const readback = await clobPrivateRequest(credentials, signerAddress, "GET", `/data/order/${encodeURIComponent(orderId)}`).catch(() => null);
      const known = readback?.status === 200 && readback.data !== null ? orderStatusResult({ orderId, requestedSize, record: readback.data }) : null;
      return tradeToolResult(known ?? { status: "UNKNOWN", orderId, orderType: FAK, requestedSize, filledSize: null, remainingSize: null, tradeIds: [], message: "Cancellation result is ambiguous and no authoritative order status was returned; do not retry blindly.", errorCode: "PS_CANCEL_UNKNOWN" });
    },
  );

  server.registerTool(
    "get_portfolio",
    {
      title: "Read public Polymarket positions and PnL",
      description: "Reads one cursor-paginated page of the default OPEN single-market positions and PnL view from Polymarket Data API v2. Pass nextCursor to continue; complete is true only after the final page of this view. The caller-provided address is not proof of wallet ownership. Closed positions and combos are not included.",
      inputSchema: z.object({
        walletAddress: addressSchema, limit: z.number().int().min(1).max(50).default(20),
        cursor: z.string().min(1).max(4_096).optional(),
      }).strict(),
      outputSchema: z.object({
        walletAddress: addressSchema, addressBinding: z.literal("PUBLIC_ADDRESS_UNVERIFIED"),
        observedAt: z.string().datetime(), sourceUrl: z.string().url(), positions: positionsResponseSchema,
        complete: z.boolean(), hasMore: z.boolean(), nextCursor: z.string().nullable(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ walletAddress, limit, cursor }) => {
      const url = new URL(`${DATA_API}/v2/positions`);
      url.searchParams.set("user", walletAddress);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("status", "OPEN");
      if (cursor !== undefined) url.searchParams.set("cursor", cursor);
      const raw = await getJson(url.toString());
      const page = positionsPageSchema.safeParse(raw);
      if (!page.success || page.data.pagination.has_more !== (page.data.pagination.next_cursor !== null)) {
        throw new Error("PS_PORTFOLIO_INVALID: Polymarket returned an unsupported positions page or inconsistent cursor metadata.");
      }
      const { data: positions, pagination } = page.data;
      return {
        content: [{ type: "text", text: `Read ${positions.length} public single-market positions for the supplied address; ${pagination.has_more ? "more pages remain" : "this is the final page"}.` }],
        structuredContent: {
          walletAddress, addressBinding: "PUBLIC_ADDRESS_UNVERIFIED", observedAt: new Date().toISOString(),
          sourceUrl: url.toString(), positions, complete: !pagination.has_more,
          hasMore: pagination.has_more, nextCursor: pagination.next_cursor,
        },
      };
    },
  );

  return server;
}

serveStdio(createServer, { legacy: "reject" });
