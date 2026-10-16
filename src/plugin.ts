import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  bytesToHex,
  concatHex,
  encodeAbiParameters,
  getAddress,
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
const ESPN_SOCCER_FEED = "https://www.espn.com/espn/rss/soccer/news";
const SPORTSDB_V1 = "https://www.thesportsdb.com/api/v1/json/123";
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
  restricted: z.boolean().optional(),
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
  timestamp: z.string().regex(/^[0-9]+$/),
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
  marketRestricted: z.boolean().nullable(), acceptingOrders: z.boolean().nullable(),
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
  version: z.enum(["v1", "v2"]).nullable(), marketRestricted: z.boolean().nullable(),
  marketAcceptingOrders: z.boolean().nullable(), tickSize: z.enum(TICK_SIZES), minOrderSize: z.string(), side: sideSchema,
  availability: z.enum(["AVAILABLE", "NO_LIQUIDITY"]), freshness: z.enum(["FRESH", "STALE", "UNKNOWN"]),
  staleAfterSeconds: z.literal(30), bestBid: z.string().nullable(), bestAsk: z.string().nullable(),
  spread: z.string().nullable(), levels: z.array(quoteLevelSchema), totalAvailableShares: z.string(),
  requestedSize: z.string().nullable(), fillableSize: z.string().nullable(), unfilledSize: z.string().nullable(),
  worstPrice: z.string().nullable(), averagePrice: z.string().nullable(), grossAmountPusd: z.string().nullable(),
  estimatedFeePusd: z.null(), bookTimestamp: z.string(), bookAgeMs: z.number().int().nullable(), observedAt: z.string().datetime(),
  source: z.literal("Polymarket CLOB"), accountGeoblockChecked: z.literal(false),
}).strict();
const providerAvailabilitySchema = z.enum(["AVAILABLE", "UNAVAILABLE"]);
const providerFreshnessSchema = z.enum(["AVAILABLE", "STALE", "UNKNOWN"]);
const soccerNewsItemSchema = z.object({
  title: z.string(), summary: z.string().nullable(), url: z.string().url(),
  publishedAt: z.string().nullable(), publishedAtUtc: z.string().datetime().nullable(),
  reportStatus: z.literal("REPORTED"), status: providerFreshnessSchema,
}).strict();
const soccerNewsOutputSchema = z.object({
  availability: providerAvailabilitySchema, reason: z.string().nullable(), provider: z.literal("ESPN"),
  sourceUrl: z.string().url(), observedAt: z.string().datetime(), staleAfterHours: z.literal(24),
  contentIsUntrusted: z.literal(true), items: z.array(soccerNewsItemSchema),
}).strict();
const sportsLeagueRecordSchema = z.object({
  idLeague: z.union([z.string(), z.number()]).optional(), strLeague: z.string().optional(), strSport: z.string().optional(),
  strCountry: z.string().nullable().optional(), strCurrentSeason: z.string().nullable().optional(),
}).passthrough();
const sportsEventSchema = z.object({
  idEvent: z.union([z.string(), z.number()]).optional(), strEvent: z.string().nullable().optional(),
  idLeague: z.union([z.string(), z.number(), z.null()]).optional(), strLeague: z.string().nullable().optional(),
  idHomeTeam: z.union([z.string(), z.number(), z.null()]).optional(), strHomeTeam: z.string().nullable().optional(),
  idAwayTeam: z.union([z.string(), z.number(), z.null()]).optional(), strAwayTeam: z.string().nullable().optional(),
  dateEvent: z.string().nullable().optional(), strTime: z.string().nullable().optional(),
  strTimestamp: z.string().nullable().optional(), intHomeScore: z.union([z.string(), z.number(), z.null()]).optional(),
  intAwayScore: z.union([z.string(), z.number(), z.null()]).optional(), strStatus: z.string().nullable().optional(),
  updated: z.string().nullable().optional(),
}).passthrough();
const soccerObservedResultSchema = z.object({
  fixtureId: z.string(), date: z.string().nullable(), opponent: z.string().nullable(), venue: z.enum(["HOME", "AWAY"]),
  score: z.string(), result: z.enum(["W", "D", "L"]),
}).strict();
const soccerFixtureSchema = z.object({
  fixtureId: z.string(), competition: z.string(), leagueProviderId: z.string(),
  homeTeam: z.string().nullable(), homeTeamProviderId: z.string().nullable(),
  awayTeam: z.string().nullable(), awayTeamProviderId: z.string().nullable(),
  eventName: z.string().nullable(), date: z.string().nullable(), providerTime: z.string().nullable(),
  kickoffUtc: z.string().datetime().nullable(), homeScore: z.string().nullable(), awayScore: z.string().nullable(),
  formCoverage: z.literal("PARTIAL_PROVIDER_SAMPLE"), homeObservedResults: z.array(soccerObservedResultSchema),
  awayObservedResults: z.array(soccerObservedResultSchema), providerUpdatedAt: z.string().nullable(),
}).strict();
const soccerSourceSchema = z.object({
  provider: z.literal("TheSportsDB"), purpose: z.enum(["LEAGUE_DISCOVERY", "FIXTURES_AND_RESULTS", "EXACT_FIXTURE"]),
  url: z.string().url(), observedAt: z.string().datetime(),
}).strict();
const soccerResearchOutputSchema = z.object({
  availability: providerAvailabilitySchema, reason: z.string().nullable(), league: z.enum(["PL", "PD", "SA", "CL"]),
  competition: z.string(), provider: z.literal("TheSportsDB"), sources: z.array(soccerSourceSchema), observedAt: z.string().datetime(),
  season: z.string().nullable(), leagueProviderId: z.string().nullable(), coverage: z.enum(["LIMITED_FREE_TIER", "UNKNOWN"]),
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
    id: z.string(), conditionId: z.string(), version: z.enum(["v1", "v2"]), outcome: z.string(), negRisk: z.boolean(),
    marketRestricted: z.boolean().nullable(), acceptingOrders: z.boolean().nullable(),
    tickSize: z.enum(TICK_SIZES),
    minOrderSize: z.string(), bookTimestamp: z.string(),
  }).strict(),
  wallet: z.object({
    type: walletTypeSchema, makerAddress: addressSchema, signingAddress: addressSchema,
    orderSignerAddress: addressSchema, signatureType: z.number().int().min(0).max(3),
  }).strict(),
  order: z.object({
    salt: z.string(), timestamp: z.string(), assetId: decimalIdSchema, side: sideSchema,
    price: z.string(), size: z.string(), maxAmount: z.string(), makerAmount: z.string(),
    takerAmount: z.string(), metadata: z.string(), builder: z.string(),
  }).strict(),
}).strict();
const preparedOrderSchema = preparedOrderBaseSchema.extend({ typedData: typedDataSchema }).strict();

type PreparedOrder = z.infer<typeof preparedOrderSchema>;
type PreparedOrderBase = z.infer<typeof preparedOrderBaseSchema>;
type TypedPayload = z.infer<typeof typedDataSchema>;

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) throw new Error(`Polymarket request failed with HTTP ${response.status}.`);
  const data: unknown = await response.json();
  return data;
}

type ProviderFetchResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: string };

async function getProviderJson(url: string): Promise<ProviderFetchResult> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return { ok: false, reason: `Provider returned HTTP ${response.status}.` };
    const body = await boundedResponseText(response, 1_000_000);
    try {
      const data: unknown = JSON.parse(body);
      return { ok: true, data };
    } catch {
      return { ok: false, reason: "Provider returned invalid JSON." };
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error && error.message === "response_too_large"
        ? "Provider response exceeded the 1 MB limit."
        : error instanceof DOMException && error.name === "TimeoutError"
          ? "Provider request timed out."
          : "Provider request failed.",
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

function formatScore(value: string | number | null | undefined): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)) return value;
  return null;
}

function sportsSeasonForDate(date: string): string {
  const [yearText, monthText] = date.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const seasonStart = month >= 7 ? year : year - 1;
  return `${seasonStart}-${seasonStart + 1}`;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function explicitUtcTimestamp(value: string | null | undefined): string | null {
  if (!value || !/(?:Z|[+-][0-9]{2}:[0-9]{2})$/i.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function sportsTeamResults(
  events: z.infer<typeof sportsEventSchema>[],
  teamId: string | null | undefined,
  cutoffDate: string | null,
): z.infer<typeof soccerObservedResultSchema>[] {
  if (!teamId) return [];
  return events.flatMap((event) => {
    const fixtureId = event.idEvent === undefined ? null : String(event.idEvent);
    const homeScore = formatScore(event.intHomeScore);
    const awayScore = formatScore(event.intAwayScore);
    const date = event.dateEvent ?? event.strTimestamp?.slice(0, 10) ?? null;
    if (!fixtureId || !homeScore || !awayScore || !date || (cutoffDate !== null && date >= cutoffDate)) return [];
    const isHome = event.idHomeTeam != null && String(event.idHomeTeam) === teamId;
    const isAway = event.idAwayTeam != null && String(event.idAwayTeam) === teamId;
    if (!isHome && !isAway) return [];
    const ownScore = BigInt(isHome ? homeScore : awayScore);
    const opponentScore = BigInt(isHome ? awayScore : homeScore);
    return [{
      fixtureId,
      date,
      opponent: isHome ? event.strAwayTeam ?? null : event.strHomeTeam ?? null,
      venue: isHome ? "HOME" as const : "AWAY" as const,
      score: `${ownScore}-${opponentScore}`,
      result: ownScore === opponentScore ? "D" as const : ownScore > opponentScore ? "W" as const : "L" as const,
    }];
  }).sort((left, right) => (right.date ?? "").localeCompare(left.date ?? "") || right.fixtureId.localeCompare(left.fixtureId)).slice(0, 5);
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
  PL: { name: "Premier League", countries: ["England"], providerNames: ["English Premier League", "Premier League"] },
  PD: { name: "LaLiga", countries: ["Spain"], providerNames: ["Spanish La Liga", "La Liga"] },
  SA: { name: "Serie A", countries: ["Italy"], providerNames: ["Italian Serie A", "Serie A"] },
  CL: { name: "UEFA Champions League", countries: ["Europe"], providerNames: ["UEFA Champions League"] },
} as const;

type SoccerLeague = keyof typeof SPORTS_COMPETITIONS;

const sportsLeagueListSchema = z.object({ leagues: z.array(sportsLeagueRecordSchema).nullable().optional() }).passthrough();
const sportsEventListSchema = z.object({
  events: z.union([sportsEventSchema, z.array(sportsEventSchema)]).nullable().optional(),
}).passthrough();

function parseSportsEvents(value: unknown): z.infer<typeof sportsEventSchema>[] | null {
  const result = sportsEventListSchema.safeParse(value);
  if (!result.success || result.data.events == null) return result.success ? [] : null;
  return Array.isArray(result.data.events) ? result.data.events : [result.data.events];
}

function sportsProviderUrl(endpoint: string, parameters: Record<string, string>): string {
  const url = new URL(`${SPORTSDB_V1}/${endpoint}`);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.toString();
}

async function findSportsLeague(league: SoccerLeague) {
  const definition = SPORTS_COMPETITIONS[league];
  const requests = definition.countries.map((country) => {
    const url = sportsProviderUrl("search_all_leagues.php", { c: country, s: "Soccer" });
    return { url, request: getProviderJson(url) };
  });
  const responses = await Promise.all(requests.map((item) => item.request));
  let failureReason: string | null = null;
  for (let index = 0; index < responses.length; index += 1) {
    const response = responses[index];
    const request = requests[index];
    if (!response || !request) continue;
    if (!response.ok) {
      failureReason ??= response.reason;
      continue;
    }
    const list = sportsLeagueListSchema.safeParse(response.data);
    if (!list.success) {
      failureReason ??= "TheSportsDB returned an unexpected league list.";
      continue;
    }
    const found = list.data.leagues?.find((item) =>
      item.strSport?.toLowerCase() === "soccer" &&
      item.strLeague !== undefined && definition.providerNames.some((name) => name === item.strLeague) &&
      item.idLeague !== undefined && /^[0-9]{1,16}$/.test(String(item.idLeague)),
    );
    if (found?.idLeague !== undefined) {
      return {
        league: found,
        source: { provider: "TheSportsDB" as const, purpose: "LEAGUE_DISCOVERY" as const, url: request.url, observedAt: new Date().toISOString() },
        reason: null,
      };
    }
  }
  return {
    league: null,
    source: requests[0]
      ? { provider: "TheSportsDB" as const, purpose: "LEAGUE_DISCOVERY" as const, url: requests[0].url, observedAt: new Date().toISOString() }
      : null,
    reason: failureReason ?? "TheSportsDB did not return an exact supported league match.",
  };
}

function validDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validSportsEvent(event: z.infer<typeof sportsEventSchema>, leagueId: string) {
  const fixtureId = event.idEvent === undefined ? null : String(event.idEvent);
  const actualLeagueId = event.idLeague == null ? null : String(event.idLeague);
  const homeTeamId = event.idHomeTeam == null ? null : String(event.idHomeTeam);
  const awayTeamId = event.idAwayTeam == null ? null : String(event.idAwayTeam);
  const date = event.dateEvent ?? event.strTimestamp?.slice(0, 10) ?? null;
  return fixtureId !== null && /^[0-9]{1,20}$/.test(fixtureId) && actualLeagueId === leagueId &&
    homeTeamId !== null && /^[0-9]{1,20}$/.test(homeTeamId) && awayTeamId !== null && /^[0-9]{1,20}$/.test(awayTeamId) &&
    date !== null && validDate(date) && event.strHomeTeam != null && event.strAwayTeam != null;
}

function mapSportsFixture(
  event: z.infer<typeof sportsEventSchema>,
  leagueId: string,
  competition: string,
  events: z.infer<typeof sportsEventSchema>[],
): z.infer<typeof soccerFixtureSchema> | null {
  if (!validSportsEvent(event, leagueId) || event.idEvent === undefined || event.idHomeTeam == null || event.idAwayTeam == null) return null;
  const homeTeamId = String(event.idHomeTeam);
  const awayTeamId = String(event.idAwayTeam);
  const date = event.dateEvent ?? event.strTimestamp?.slice(0, 10) ?? null;
  if (!date) return null;
  return {
    fixtureId: String(event.idEvent),
    competition,
    leagueProviderId: leagueId,
    homeTeam: event.strHomeTeam ?? null,
    homeTeamProviderId: homeTeamId,
    awayTeam: event.strAwayTeam ?? null,
    awayTeamProviderId: awayTeamId,
    eventName: event.strEvent ?? null,
    date,
    providerTime: event.strTime ?? null,
    kickoffUtc: explicitUtcTimestamp(event.strTimestamp),
    homeScore: formatScore(event.intHomeScore),
    awayScore: formatScore(event.intAwayScore),
    formCoverage: "PARTIAL_PROVIDER_SAMPLE",
    homeObservedResults: sportsTeamResults(events, homeTeamId, date),
    awayObservedResults: sportsTeamResults(events, awayTeamId, date),
    providerUpdatedAt: event.updated ?? null,
  };
}

async function getSoccerNews(limit: number): Promise<z.infer<typeof soccerNewsOutputSchema>> {
  const observedAt = new Date().toISOString();
  try {
    const response = await fetch(ESPN_SOCCER_FEED, {
      headers: { accept: "application/rss+xml, application/xml, text/xml" },
      redirect: "error",
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) {
      return soccerNewsOutputSchema.parse({
        availability: "UNAVAILABLE", reason: `ESPN returned HTTP ${response.status}.`, provider: "ESPN",
        sourceUrl: ESPN_SOCCER_FEED, observedAt, staleAfterHours: 24, contentIsUntrusted: true, items: [],
      });
    }
    const xml = await boundedResponseText(response, MAX_RSS_BYTES);
    if (/<!DOCTYPE\b/i.test(xml) || XMLValidator.validate(xml) !== true) {
      return soccerNewsOutputSchema.parse({
        availability: "UNAVAILABLE", reason: "ESPN feed did not pass safe XML validation.", provider: "ESPN",
        sourceUrl: ESPN_SOCCER_FEED, observedAt, staleAfterHours: 24, contentIsUntrusted: true, items: [],
      });
    }
    const parsed: unknown = RSS_XML_PARSER.parse(xml);
    const sourceItems = rssItems(parsed);
    if (sourceItems === null) {
      return soccerNewsOutputSchema.parse({
        availability: "UNAVAILABLE", reason: "ESPN feed did not match the expected RSS shape.", provider: "ESPN",
        sourceUrl: ESPN_SOCCER_FEED, observedAt, staleAfterHours: 24, contentIsUntrusted: true, items: [],
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
      return [{
        title: decodeRssEntities(item.title),
        summary: item.description === undefined ? null : decodeRssEntities(item.description),
        url: item.link,
        publishedAt,
        publishedAtUtc: Number.isFinite(publishedMs) ? new Date(publishedMs).toISOString() : null,
        reportStatus: "REPORTED" as const,
        status,
      }];
    }).slice(0, limit);
    return soccerNewsOutputSchema.parse({
      availability: items.length > 0 ? "AVAILABLE" : "UNAVAILABLE",
      reason: items.length > 0 ? null : "ESPN feed contained no valid soccer stories.",
      provider: "ESPN", sourceUrl: ESPN_SOCCER_FEED, observedAt, staleAfterHours: 24,
      contentIsUntrusted: true, items,
    });
  } catch (error) {
    const reason = error instanceof Error && error.message === "response_too_large"
      ? "ESPN feed exceeded the 256 KB limit."
      : error instanceof DOMException && error.name === "TimeoutError"
        ? "ESPN feed request timed out."
        : "ESPN feed request or parsing failed.";
    return soccerNewsOutputSchema.parse({
      availability: "UNAVAILABLE", reason, provider: "ESPN", sourceUrl: ESPN_SOCCER_FEED,
      observedAt, staleAfterHours: 24, contentIsUntrusted: true, items: [],
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
  const discovery = await findSportsLeague(input.league);
  if (!discovery.league || discovery.league.idLeague === undefined) {
    return soccerResearchOutputSchema.parse({
      availability: "UNAVAILABLE", reason: discovery.reason, league: input.league,
      competition: definition.name, provider: "TheSportsDB", sources: discovery.source ? [discovery.source] : [], observedAt,
      season: null, leagueProviderId: null, coverage: "UNKNOWN", returnedEventCount: 0, fixtures: [],
    });
  }
  const leagueId = String(discovery.league.idLeague);
  const season = sportsSeasonForDate(startDate);
  const scheduleUrl = sportsProviderUrl("eventsseason.php", { id: leagueId, s: season });
  const exactFixtureUrl = input.fixtureId ? sportsProviderUrl("lookupevent.php", { id: input.fixtureId }) : null;
  const [scheduleResponse, exactFixtureResponse] = await Promise.all([
    getProviderJson(scheduleUrl),
    exactFixtureUrl ? getProviderJson(exactFixtureUrl) : Promise.resolve(null),
  ]);
  const sources: z.infer<typeof soccerSourceSchema>[] = discovery.source === null ? [] : [discovery.source];
  sources.push({
    provider: "TheSportsDB" as const, purpose: "FIXTURES_AND_RESULTS" as const, url: scheduleUrl, observedAt: new Date().toISOString(),
  });
  if (exactFixtureUrl) sources.push({
    provider: "TheSportsDB" as const, purpose: "EXACT_FIXTURE" as const, url: exactFixtureUrl, observedAt: new Date().toISOString(),
  });

  const scheduleEvents = scheduleResponse.ok ? parseSportsEvents(scheduleResponse.data) : null;
  const exactEvents = exactFixtureResponse?.ok ? parseSportsEvents(exactFixtureResponse.data) : null;
  const allEvents = scheduleEvents ?? [];
  if (exactEvents) {
    for (const exactEvent of exactEvents) {
      if (String(exactEvent.idEvent ?? "") === input.fixtureId && String(exactEvent.idLeague ?? "") === leagueId &&
        !allEvents.some((event) => String(event.idEvent ?? "") === input.fixtureId)) allEvents.push(exactEvent);
    }
  }
  const validEvents = allEvents.filter((event) => validSportsEvent(event, leagueId));
  const selectedEvents = input.fixtureId
    ? validEvents.filter((event) => String(event.idEvent) === input.fixtureId)
    : validEvents.filter((event) => {
        const date = event.dateEvent ?? event.strTimestamp?.slice(0, 10) ?? "";
        return date >= startDate && date <= endDate;
      });
  const fixtures = selectedEvents
    .map((event) => mapSportsFixture(event, leagueId, definition.name, validEvents))
    .filter((fixture): fixture is z.infer<typeof soccerFixtureSchema> => fixture !== null)
    .sort((left, right) => (left.date ?? "").localeCompare(right.date ?? "") || left.fixtureId.localeCompare(right.fixtureId))
    .slice(0, input.limit);
  const providerDataAvailable = scheduleEvents !== null || exactEvents !== null;
  const reason = !providerDataAvailable
    ? scheduleResponse.ok ? "TheSportsDB returned an unexpected event schedule." : scheduleResponse.reason
    : input.fixtureId && fixtures.length === 0
      ? "TheSportsDB did not return that exact fixture for the selected league."
      : fixtures.length === 0 ? "TheSportsDB returned no fixtures for the requested date window." : null;
  return soccerResearchOutputSchema.parse({
    availability: providerDataAvailable ? "AVAILABLE" : "UNAVAILABLE",
    reason,
    league: input.league,
    competition: definition.name,
    provider: "TheSportsDB",
    sources,
    observedAt,
    season,
    leagueProviderId: leagueId,
    coverage: providerDataAvailable ? "LIMITED_FREE_TIER" : "UNKNOWN",
    returnedEventCount: scheduleEvents?.length ?? 0,
    fixtures,
  });
}

function toUnits(value: string, decimals: number, maxInputDecimals = decimals): bigint {
  if (value.length > 128 || !/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    throw new Error("Use a nonnegative decimal string without exponent notation.");
  }
  const parts = value.split(".");
  const whole = parts[0] ?? "0";
  const fraction = parts[1] ?? "";
  if (fraction.length > maxInputDecimals || fraction.length > decimals) {
    throw new Error(`Amount supports at most ${maxInputDecimals} decimal places.`);
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
            marketRestricted: market.restricted ?? null,
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
      description: "Reads the public CLOB book for one market outcome and estimates how much of an optional BUY or SELL share size is visible in the current book. No order is created. Quotes older than 30 seconds are marked stale; refresh before any later signing step.",
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
        throw new Error("The selected market is not active.");
      }
      if (!market.question) throw new Error("The selected market has no question text.");
      if (!market.conditionId || book.asset_id !== assetId || book.market.toLowerCase() !== market.conditionId.toLowerCase()) {
        throw new Error("CLOB book identity does not match the selected market and outcome.");
      }
      const mappedOutcomes = marketOutcomeAssets(market);
      const selectedOutcome = mappedOutcomes?.find((outcome) => outcome.assetId === assetId);
      if (!selectedOutcome) throw new Error("The asset ID is not mapped to an outcome in this market.");
      if (market.negRisk !== undefined && market.negRisk !== book.neg_risk) {
        throw new Error("Market and CLOB book disagree about the negative-risk exchange.");
      }
      if (book.version && market.version && book.version !== market.version) {
        throw new Error("Gamma market and CLOB book protocol versions do not match.");
      }

      const toLevels = (entries: Array<{ price: string; size: string }>) => entries.map((entry) => {
        const priceUnits = toUnits(entry.price, 6);
        const sizeUnits = toUnits(entry.size, 6);
        if (priceUnits <= 0n || priceUnits >= 1_000_000n || sizeUnits <= 0n) throw new Error("CLOB returned an invalid price or size level.");
        return { priceUnits, sizeUnits };
      });
      const bids = toLevels(book.bids).sort((left, right) => left.priceUnits === right.priceUnits ? 0 : left.priceUnits > right.priceUnits ? -1 : 1);
      const asks = toLevels(book.asks).sort((left, right) => left.priceUnits === right.priceUnits ? 0 : left.priceUnits < right.priceUnits ? -1 : 1);
      const visibleLevels = side === "BUY" ? asks : bids;
      const totalAvailable = visibleLevels.reduce((total, level) => total + level.sizeUnits, 0n);
      const requestedUnits = size === undefined ? null : toUnits(size, 6, 6);
      if (requestedUnits !== null && requestedUnits <= 0n) throw new Error("Quote size must be greater than zero shares.");
      let filledUnits = 0n;
      let unfilledUnits = requestedUnits ?? 0n;
      let quoteScaled12 = 0n;
      let worstPriceUnits: bigint | null = null;
      if (requestedUnits !== null) {
        for (const level of visibleLevels) {
          if (unfilledUnits === 0n) break;
          const take = level.sizeUnits < unfilledUnits ? level.sizeUnits : unfilledUnits;
          filledUnits += take;
          unfilledUnits -= take;
          quoteScaled12 += take * level.priceUnits;
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
        marketRestricted: market.restricted ?? null,
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
        estimatedFeePusd: null,
        bookTimestamp: book.timestamp,
        bookAgeMs: ageMs,
        observedAt,
        source: "Polymarket CLOB",
        accountGeoblockChecked: false,
      });
      return { content: [{ type: "text", text: `Read the current public ${side} quote. No order was created.` }], structuredContent };
    },
  );

  server.registerTool(
    "get_soccer_news",
    {
      title: "Read ESPN soccer headlines",
      description: "Reads ESPN's public soccer RSS headlines and supplied summaries. Items are attributed and linked unchanged, marked REPORTED, and treated as untrusted; they are not verified injury or lineup records.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(10).default(5) }).strict(),
      outputSchema: soccerNewsOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ limit }) => {
      const structuredContent = await getSoccerNews(limit);
      return { content: [{ type: "text", text: structuredContent.availability === "AVAILABLE" ? `Read ${structuredContent.items.length} ESPN soccer headlines.` : `ESPN soccer news is unavailable: ${structuredContent.reason}` }], structuredContent };
    },
  );

  server.registerTool(
    "research_soccer",
    {
      title: "Research supported soccer fixtures",
      description: "Reads TheSportsDB fixture and result data for Premier League, LaLiga, Serie A, or UEFA Champions League. Exact fixture IDs are matched literally. Provider coverage is limited; past-five results are only partial when returned, never comprehensive by default.",
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
      if (date !== undefined && !validDate(date)) throw new Error("Use a valid UTC calendar date in YYYY-MM-DD format.");
      const structuredContent = await getSoccerResearch({ league, date, days, fixtureId, limit });
      return { content: [{ type: "text", text: structuredContent.availability === "AVAILABLE" ? `Read ${structuredContent.fixtures.length} ${structuredContent.competition} fixtures from TheSportsDB.` : `${structuredContent.competition} data is unavailable: ${structuredContent.reason}` }], structuredContent };
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
      if (BigInt(nonce) >= 1n << 256n) throw new Error("Nonce exceeds uint256.");
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
      description: "Reads the selected market and current CLOB book, validates order precision and a caller-supplied cap, then prepares EIP-712 data. It never submits an order. maxAmount is pre-fee pUSD maker amount for BUY and outcome shares for SELL. Gamma's marketRestricted flag can apply only in some jurisdictions and is not an account-specific geoblock result.",
      inputSchema: z.object({
        marketId: z.string().regex(/^[0-9]{1,32}$/), assetId: decimalIdSchema,
        makerAddress: addressSchema, signingAddress: addressSchema,
        walletType: walletTypeSchema, side: sideSchema,
        price: z.string().max(32), size: z.string().max(32), maxAmount: z.string().max(32),
      }).strict(),
      outputSchema: z.object({
        preparedOrder: preparedOrderSchema,
        requestWalletSignIntent: requestWalletSignIntentSchema,
        submitsOrder: z.literal(false),
        maxAmountIncludesFees: z.literal(false),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ marketId, assetId, makerAddress, signingAddress, walletType, side, price, size, maxAmount }) => {
      const marketUrl = `https://gamma-api.polymarket.com/markets/${encodeURIComponent(marketId)}`;
      const bookUrl = new URL("https://clob.polymarket.com/book");
      bookUrl.searchParams.set("token_id", assetId);
      const [rawMarket, rawBook] = await Promise.all([getJson(marketUrl), getJson(bookUrl.toString())]);
      const market = gammaMarketSchema.parse(rawMarket);
      const book = bookSchema.parse(rawBook);
      if (String(market.id) !== marketId || market.active !== true || market.closed !== false) {
        throw new Error("The selected market is not active and tradable.");
      }
      if (market.enableOrderBook === false || market.acceptingOrders !== true || !market.conditionId || market.version === undefined || market.version === null) {
        throw new Error("The selected market is missing supported CLOB trading metadata.");
      }
      const mappedOutcomes = marketOutcomeAssets(market);
      const selectedOutcome = mappedOutcomes?.find((outcome) => outcome.assetId === assetId);
      if (!selectedOutcome) throw new Error("The asset ID is not mapped to an outcome in this market.");
      if (book.asset_id !== assetId || book.market.toLowerCase() !== market.conditionId.toLowerCase()) {
        throw new Error("CLOB book identity does not match the selected market and outcome.");
      }
      if (market.negRisk !== undefined && market.negRisk !== book.neg_risk) {
        throw new Error("Market and CLOB book disagree about the negative-risk exchange.");
      }
      if (book.version && book.version !== market.version) {
        throw new Error("Gamma market and CLOB book protocol versions do not match.");
      }

      const maker = address(makerAddress);
      const signing = address(signingAddress);
      if (walletType === "EOA" && maker.toLowerCase() !== signing.toLowerCase()) {
        throw new Error("For an EOA account, maker and PayBox signing addresses must match.");
      }
      const orderSigner = walletType === "DEPOSIT_WALLET" ? maker : signing;
      const rules = TICK_RULES[book.tick_size];
      const priceUnits = toUnits(price, 6, rules.priceDecimals);
      const sizeUnits = toUnits(size, 6, 2);
      const capUnits = toUnits(maxAmount, 6, 6);
      const tickUnits = toUnits(book.tick_size, 6, rules.priceDecimals);
      const minSizeUnits = toUnits(book.min_order_size, 6, 6);
      const quoteUnits = (priceUnits * sizeUnits) / 1_000_000n;
      if (priceUnits <= 0n || priceUnits >= 1_000_000n || priceUnits % tickUnits !== 0n) {
        throw new Error(`Price must be between 0 and 1 and conform to tick size ${book.tick_size}.`);
      }
      if (sizeUnits < minSizeUnits) throw new Error(`Size is below the market minimum of ${book.min_order_size} shares.`);
      if ((priceUnits * sizeUnits) % 1_000_000n !== 0n) throw new Error("Order amount cannot be represented at six-decimal precision.");
      const amountUnit = side === "BUY" ? "pUSD" : "outcome shares";
      const boundedAmount = side === "BUY" ? quoteUnits : sizeUnits;
      if (capUnits === 0n || boundedAmount > capUnits) throw new Error(`Order exceeds the supplied ${amountUnit} maxAmount.`);
      const amountPrecision = 10n ** BigInt(6 - rules.amountDecimals);
      if (quoteUnits % amountPrecision !== 0n) throw new Error(`Order quote exceeds this market's ${rules.amountDecimals}-decimal amount precision.`);

      const saltBytes = crypto.getRandomValues(new Uint8Array(8));
      const rawSalt = BigInt(bytesToHex(saltBytes));
      const salt = (rawSalt % BigInt(Number.MAX_SAFE_INTEGER)).toString();
      const timestamp = String(Date.now());
      const makerAmount = (side === "BUY" ? quoteUnits : sizeUnits).toString();
      const takerAmount = (side === "BUY" ? sizeUnits : quoteUnits).toString();
      const preparedBase = preparedOrderBaseSchema.parse({
        market: {
          id: marketId, conditionId: market.conditionId, version: market.version, outcome: selectedOutcome.name,
          negRisk: book.neg_risk, marketRestricted: market.restricted ?? null,
          acceptingOrders: market.acceptingOrders, tickSize: book.tick_size,
          minOrderSize: book.min_order_size, bookTimestamp: book.timestamp,
        },
        wallet: {
          type: walletType, makerAddress: maker, signingAddress: signing,
          orderSignerAddress: orderSigner, signatureType: signatureType(walletType),
        },
        order: {
          salt, timestamp, assetId, side, price, size, maxAmount,
          makerAmount, takerAmount, metadata: ZERO32, builder: ZERO32,
        },
      });
      const typedData = wireTypedData(signingPayload(preparedBase));
      const preparedOrder = preparedOrderSchema.parse({ ...preparedBase, typedData });
      const intent = { op: "typedData" as const, typedData };
      return {
        content: [{ type: "text", text: `Prepared a bounded ${side} signing payload. No order was submitted.` }],
        structuredContent: { preparedOrder, requestWalletSignIntent: intent, submitsOrder: false, maxAmountIncludesFees: false },
      };
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
      if (BigInt(nonce) >= 1n << 256n) throw new Error("Nonce exceeds uint256.");
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
      description: "Rebuilds the exact EIP-712 order payload, checks amount caps and recovers the PayBox signing address. Deposit Wallet output includes the documented ERC-7739 wrapper; on-chain ERC-1271 validation is not performed.",
      inputSchema: z.object({ preparedOrder: preparedOrderSchema, signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).strict(),
      outputSchema: z.object({
        valid: z.boolean(), expectedSignerAddress: addressSchema, recoveredSignerAddress: addressSchema.nullable(),
        signatureEncoding: z.enum(["EIP-712", "ERC-7739"]), signedOrderSignature: z.string().nullable(),
        onchainWalletValidation: z.literal(false),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ preparedOrder: parsedPrepared, signature }) => {
      const prepared = preparedOrderSchema.parse(parsedPrepared);
      const p = prepared.order;
      const priceUnits = toUnits(p.price, 6, TICK_RULES[prepared.market.tickSize].priceDecimals);
      const sizeUnits = toUnits(p.size, 6, 2);
      const capUnits = toUnits(p.maxAmount, 6, 6);
      const quoteUnits = (priceUnits * sizeUnits) / 1_000_000n;
      const amount = p.side === "BUY" ? quoteUnits : sizeUnits;
      const expectedMakerAmount = (p.side === "BUY" ? quoteUnits : sizeUnits).toString();
      const expectedTakerAmount = (p.side === "BUY" ? sizeUnits : quoteUnits).toString();
      const amountPrecision = 10n ** BigInt(6 - TICK_RULES[prepared.market.tickSize].amountDecimals);
      if (priceUnits <= 0n || priceUnits >= 1_000_000n || priceUnits % toUnits(prepared.market.tickSize, 6) !== 0n) {
        throw new Error("Prepared order price no longer matches its tick-size constraints.");
      }
      if (sizeUnits < toUnits(prepared.market.minOrderSize, 6) || amount > capUnits || capUnits === 0n || quoteUnits % amountPrecision !== 0n) {
        throw new Error("Prepared order violates its share minimum or maxAmount.");
      }
      if (prepared.wallet.signatureType !== signatureType(prepared.wallet.type)) {
        throw new Error("Wallet type and Polymarket signature type do not match.");
      }
      const expectedOrderSigner = prepared.wallet.type === "DEPOSIT_WALLET"
        ? prepared.wallet.makerAddress
        : prepared.wallet.signingAddress;
      if (prepared.wallet.orderSignerAddress.toLowerCase() !== expectedOrderSigner.toLowerCase()) {
        throw new Error("Order signer does not match the selected Polymarket wallet type.");
      }
      if (p.makerAmount !== expectedMakerAmount || p.takerAmount !== expectedTakerAmount || p.metadata !== ZERO32 || p.builder !== ZERO32) {
        throw new Error("Prepared order amounts or fixed metadata do not match its price and size.");
      }
      const signatureValue = signatureHex(signature);
      let recovered: Address | null = null;
      try {
        recovered = prepared.wallet.type === "DEPOSIT_WALLET"
          ? await recoverTypedDataAddress({ ...depositOrderPayload(prepared), signature: signatureValue })
          : await recoverTypedDataAddress({ ...standardOrderPayload(prepared), signature: signatureValue });
      } catch {
        recovered = null;
      }
      const expected = address(prepared.wallet.signingAddress);
      const valid = recovered?.toLowerCase() === expected.toLowerCase();
      const signedOrderSignature = valid
        ? prepared.wallet.type === "DEPOSIT_WALLET" ? wrapDepositWalletSignature(prepared, signatureValue) : signatureValue
        : null;
      return {
        content: [{ type: "text", text: valid ? "Order signature matches the expected PayBox signer; no order was submitted." : "Order signature is invalid or belongs to a different signer." }],
        structuredContent: {
          valid,
          expectedSignerAddress: expected,
          recoveredSignerAddress: recovered,
          signatureEncoding: prepared.wallet.type === "DEPOSIT_WALLET" ? "ERC-7739" : "EIP-712",
          signedOrderSignature,
          onchainWalletValidation: false,
        },
      };
    },
  );

  return server;
}

serveStdio(createServer, { legacy: "reject" });
