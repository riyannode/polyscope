import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  createPublicClient as createPolymarketClient, createSecureClient, OrderSide, OrderType, SignerType,
  RequestRejectedError, RateLimitError, type Signer, type SignedOrder, type TypedDataPayload,
} from "@polymarket/client";
import { createOrDeriveApiKey, fetchMarketInfo, prepareLimitOrder, prepareRedeemMarketPositions, prepareRedeemPosition } from "@polymarket/client/actions";
import { toTokenId } from "@polymarket/bindings";
import { expectEvmAddress, expectEvmSignature, expectErc1271Signature, expectHexString } from "@polymarket/types";
import {
  concatHex,
  getAddress,
  hashTypedData, domainSeparator, hashStruct,
  recoverTypedDataAddress,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import * as z from "zod/v4";

// The SDK transport may retry DELETE; each tool invocation permits one mutation per endpoint.
const sdkHttpScope = new AsyncLocalStorage<{ writes: Set<string>; mutationStatus?: number; responseStatus?: number }>();
function runSdk<T>(call: () => Promise<T>): Promise<T> {
  return sdkHttpScope.run({ writes: new Set() }, call);
}
const hostFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const scope = sdkHttpScope.getStore();
  if (!scope) return hostFetch(input, init);
  const request = new Request(input, init);
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const key = `${request.method} ${request.url}`;
    if (scope.writes.has(key)) throw new Error("PS_MUTATION_RETRY_BLOCKED: Reconcile the original request read-only.");
    scope.writes.add(key);
  }
  const response = await hostFetch(new Request(request, { redirect: "error", signal: request.signal }));
  scope.responseStatus = response.status;
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) scope.mutationStatus = response.status;
  return response;
};

const PROTOCOL_VERSION = "2026-07-28";
const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
const GEOBLOCK_API = "https://polymarket.com/api/geoblock";
const ESPN_SOCCER_FEED = "https://www.espn.com/espn/rss/soccer/news";
const FOOTBALL_DATA_API = "https://api.football-data.org/v4";
const API_FOOTBALL_API = "https://v3.football.api-sports.io";
const NEWS_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_RSS_BYTES = 256 * 1024;
const RSS_XML_PARSER = new XMLParser({ ignoreAttributes: true, processEntities: false, trimValues: false });
const ZERO32 = `0x${"0".repeat(64)}` as const;
const TICK_SIZES = ["0.1", "0.01", "0.005", "0.0025", "0.001", "0.0001"] as const;
const FAK = "FAK" as const;

const preparationErrorCodeSchema = z.enum([
  "PS_MARKET_IDENTITY", "PS_PROVIDER_INVALID", "PS_PROVIDER_UNAVAILABLE",
  "PS_PROVIDER_TIMEOUT", "PS_RESPONSE_TOO_LARGE", "PS_MARKET_UNSUPPORTED", "PS_WALLET_BINDING",
  "PS_CLOB_AUTH_REJECTED", "PS_AUTH_SIGNATURE_INVALID", "PS_AUTH_WALLET_MISMATCH",
]);

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
  formSources: z.array(z.object({ provider: z.literal("football-data.org"), url: z.string().url(), observedAt: z.string().datetime() }).strict()).optional(),
  apiFootball: z.object({
    availability: providerAvailabilitySchema, reason: z.string().nullable(),
    sourceUrl: z.string().url(), observedAt: z.string().datetime(),
    matchIdentity: z.object({ providerFixtureId: z.string(), providerLeagueId: z.string(), providerSeason: z.number().int(),
      competition: z.string(), homeTeam: z.string(), homeTeamProviderId: z.string(), awayTeam: z.string(), awayTeamProviderId: z.string(), kickoffUtc: z.string().datetime() }).strict().nullable(),
    homeStats: z.object({ providerTeamId: z.string(), playedAtHome: z.number().int().nonnegative(), goalsForAverage: z.number().finite().nonnegative().nullable(), goalsAgainstAverage: z.number().finite().nonnegative().nullable() }).strict().nullable(),
    awayStats: z.object({ providerTeamId: z.string(), playedAway: z.number().int().nonnegative(), goalsForAverage: z.number().finite().nonnegative().nullable(), goalsAgainstAverage: z.number().finite().nonnegative().nullable() }).strict().nullable(),
    sources: z.array(z.object({ provider: z.literal("API-Football"), purpose: z.enum(["MATCH_ENRICHMENT", "TEAM_STATISTICS"]), url: z.string().url(), observedAt: z.string().datetime(),
      teamProviderId: z.string().optional(), teamName: z.string().optional(), availability: providerAvailabilitySchema.optional(),
      httpStatus: z.number().int().min(100).max(599).nullable().optional(), reason: z.string().nullable().optional() }).strict()),
  }).strict().optional(),
}).strict();
const fixtureEvidenceStatusSchema = z.enum(["VERIFIED", "PARTIAL", "UNVERIFIED", "CONFLICTED"]);
const fixtureIdentitySchema = z.object({
  homeTeam: z.string().trim().min(1).max(120), awayTeam: z.string().trim().min(1).max(120),
  kickoffUtc: z.string().datetime(),
}).strict();
const providerQualifiedFixtureSchema = z.object({
  provider: z.literal("API-Football"), providerFixtureId: z.string(), providerLeagueId: z.string(), providerSeason: z.number().int(),
  competition: z.string(), homeTeam: z.string(), providerHomeTeamId: z.string(), awayTeam: z.string(), providerAwayTeamId: z.string(),
  kickoffUtc: z.string().datetime(), status: z.string().nullable(), homeScore: z.number().int().nonnegative().nullable(), awayScore: z.number().int().nonnegative().nullable(),
  observedAt: z.string().datetime(), sourceUrl: z.string().url(), verificationStatus: fixtureEvidenceStatusSchema,
  confidenceCategory: z.enum(["LOW", "MODERATE", "HIGH"]), confidenceReason: z.string(),
  statisticsAvailability: providerAvailabilitySchema, statisticsReason: z.string().nullable(),
  homeStats: z.object({ providerTeamId: z.string(), playedAtHome: z.number().int().nonnegative(), goalsForAverage: z.number().finite().nonnegative().nullable(), goalsAgainstAverage: z.number().finite().nonnegative().nullable() }).strict().nullable(),
  awayStats: z.object({ providerTeamId: z.string(), playedAway: z.number().int().nonnegative(), goalsForAverage: z.number().finite().nonnegative().nullable(), goalsAgainstAverage: z.number().finite().nonnegative().nullable() }).strict().nullable(),
  sources: z.array(z.object({ provider: z.literal("API-Football"), purpose: z.enum(["FIXTURES_AND_RESULTS", "TEAM_STATISTICS"]), url: z.string().url(), observedAt: z.string().datetime(),
    teamProviderId: z.string().optional(), teamName: z.string().optional(), availability: providerAvailabilitySchema,
    httpStatus: z.number().int().min(100).max(599).nullable(), reason: z.string().nullable() }).strict()),
}).strict();
const soccerSourceSchema = z.object({
  provider: z.enum(["football-data.org", "API-Football"]), purpose: z.enum(["FIXTURES_AND_RESULTS", "EXACT_FIXTURE", "TEAM_FORM", "MATCH_ENRICHMENT", "TEAM_STATISTICS"]),
  url: z.string().url(), observedAt: z.string().datetime(),
  teamProviderId: z.string().optional(), teamName: z.string().optional(),
  availability: providerAvailabilitySchema.optional(), httpStatus: z.number().int().min(100).max(599).nullable().optional(),
  returnedResultCount: z.number().int().nonnegative().nullable().optional(),
  reason: z.string().nullable().optional(),
}).strict();
const fallbackCoverageSchema = z.object({
  requestedDateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), requestedDateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  queriedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), datesNotQueried: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  status: z.enum(["COMPLETE", "PARTIAL"]), continuationInstruction: z.string(),
}).strict();
const soccerResearchOutputSchema = z.object({
  availability: providerAvailabilitySchema, reason: z.string().nullable(), league: z.enum(["PL", "PD", "SA", "CL"]),
  competition: z.string(), provider: z.literal("football-data.org"), sources: z.array(soccerSourceSchema), observedAt: z.string().datetime(),
  season: z.string().nullable(), leagueProviderId: z.string().nullable(), resultProvider: z.enum(["football-data.org", "API-Football"]).optional(),
  coverage: z.enum(["RETURNED_MATCHES", "FALLBACK_MATCHES", "PARTIAL_FALLBACK_MATCHES", "UNAVAILABLE"]),
  returnedEventCount: z.number().int(), fixtures: z.array(soccerFixtureSchema),
  fallbackProvider: z.object({ provider: z.literal("API-Football"), availability: providerAvailabilitySchema, reason: z.string().nullable(),
    sourceUrl: z.string().url(), observedAt: z.string().datetime(), httpStatus: z.number().int().min(100).max(599).nullable(),
    verificationStatus: fixtureEvidenceStatusSchema, confidenceCategory: z.enum(["LOW", "MODERATE", "HIGH"]), confidenceReason: z.string(),
    coverage: fallbackCoverageSchema }).strict().optional(),
  fallbackFixtures: z.array(providerQualifiedFixtureSchema).optional(),
}).strict();
const soccerEdgeOutputSchema = z.object({
  probabilityStatus: z.enum(["AVAILABLE", "UNAVAILABLE"]), probabilityReason: z.string().nullable(),
  model: z.object({ name: z.literal("Independent Poisson Goals Model"), version: z.literal("1.0.0"),
    expectedHomeGoals: z.number().finite().nonnegative().nullable(), expectedAwayGoals: z.number().finite().nonnegative().nullable(),
    homeWin: z.number().finite().min(0).max(1).nullable(), draw: z.number().finite().min(0).max(1).nullable(), awayWin: z.number().finite().min(0).max(1).nullable(),
    truncatedTailProbability: z.number().finite().min(0).max(1).nullable(), normalized: z.boolean(),
    inputs: z.object({ statisticsProvider: z.enum(["API-Football", "football-data.org"]).nullable(),
      homeGoalsForAverageAtHome: z.number().finite().nonnegative().nullable(), homeGoalsAgainstAverageAtHome: z.number().finite().nonnegative().nullable(),
      awayGoalsForAverageAway: z.number().finite().nonnegative().nullable(), awayGoalsAgainstAverageAway: z.number().finite().nonnegative().nullable(),
      homeMatchesAtHome: z.number().int().nonnegative().nullable(), awayMatchesAway: z.number().int().nonnegative().nullable(), cutoffDate: z.string().nullable() }).strict(),
    sources: z.array(z.object({ provider: z.enum(["API-Football", "football-data.org"]), url: z.string().url(), observedAt: z.string().datetime() }).strict()), assumptions: z.array(z.string()), uncertainty: z.array(z.string()),
    calculatedAt: z.string().datetime() }).strict(),
  edgeStatus: z.enum(["AVAILABLE", "UNAVAILABLE", "UNSUPPORTED_MARKET"]), edgeReason: z.string().nullable(),
  marketId: z.string().nullable(), assetId: decimalIdSchema.nullable(), marketOutcome: z.string().nullable(), outcome: z.enum(["HOME_WIN", "DRAW", "AWAY_WIN"]),
  requestedShares: z.string().nullable(), fillableShares: z.string().nullable(), unfilledShares: z.string().nullable(),
  bestBid: z.string().nullable(), bestAsk: z.string().nullable(), spread: z.string().nullable(), depthWeightedExecutionPrice: z.string().nullable(), estimatedFeesPusd: z.string().nullable(),
  effectiveBuyCostPerShare: z.string().nullable(), grossProbabilityPriceDifference: z.string().nullable(), netEdgePerShare: z.string().nullable(),
  estimatedExpectedValuePusd: z.string().nullable(), quoteObservedAt: z.string().datetime().nullable(), quoteBookTimestamp: z.string().nullable(),
  quoteFreshness: z.enum(["FRESH", "STALE", "UNKNOWN"]), quoteFreshnessAtCapture: z.enum(["FRESH", "STALE", "UNKNOWN"]),
  quoteAgeMsAtAnalysis: z.number().int().nonnegative().nullable(), quoteStaleAfterSeconds: z.literal(30),
  calculationAssumptions: z.array(z.string()),
  identityEvidence: z.array(z.object({ provider: z.string(), url: z.string().url(), observedAt: z.string().datetime(), publishedAt: z.string().datetime().nullable(),
    verificationStatus: fixtureEvidenceStatusSchema, confidenceCategory: z.enum(["LOW", "MODERATE", "HIGH"]), confidenceReason: z.string(),
    competition: z.string(), homeTeam: z.string(), awayTeam: z.string(), kickoffUtc: z.string().datetime(),
    attestationAuthority: z.literal("HOST_AGENT") }).strict()).optional(),
  marketMapping: z.object({ provider: z.literal("Polymarket Gamma"), url: z.string().url(), observedAt: z.string().datetime(),
    marketId: z.string(), question: z.string(), outcome: z.string(), competition: z.string(), homeTeam: z.string(), awayTeam: z.string(),
    kickoffUtc: z.string().datetime(), outcomeMapping: z.enum(["HOME_WIN", "DRAW", "AWAY_WIN"]),
    resolutionType: z.enum(["REGULATION_1X2", "OTHER", "UNKNOWN"]), resolutionRules: z.string(), attestationAuthority: z.literal("HOST_AGENT") }).strict().optional(),
  evidenceAssessment: z.object({ claimAuthority: z.literal("HOST_AGENT"), sourceVerification: z.literal("NOT_PERFORMED_BY_POLYSCOPE"),
    identityClaimMatchesFixture: z.boolean(), marketClaimMatchesSuppliedQuoteAndFixture: z.boolean() }).strict().optional(),
}).strict();
const identityEvidenceSchema = z.object({ provider: z.string().trim().min(1).max(120), url: z.string().url(), observedAt: z.string().datetime(),
  publishedAt: z.string().datetime().nullable(), verificationStatus: fixtureEvidenceStatusSchema,
  confidenceCategory: z.enum(["LOW", "MODERATE", "HIGH"]), confidenceReason: z.string().min(1).max(500),
  competition: z.string().min(1).max(120), homeTeam: z.string().min(1).max(120), awayTeam: z.string().min(1).max(120), kickoffUtc: z.string().datetime() }).strict();
const marketMappingSchema = z.object({ provider: z.literal("Polymarket Gamma"), url: z.string().url(), observedAt: z.string().datetime(),
  marketId: z.string(), question: z.string(), outcome: z.string(), competition: z.string(), homeTeam: z.string(), awayTeam: z.string(),
  kickoffUtc: z.string().datetime(), outcomeMapping: z.enum(["HOME_WIN", "DRAW", "AWAY_WIN"]),
  resolutionType: z.enum(["REGULATION_1X2", "OTHER", "UNKNOWN"]), resolutionRules: z.string().min(1).max(4_000) }).strict();
const apiFootballFixtureSchema = z.object({
  fixture: z.object({ id: z.number().int().positive(), date: z.string().datetime({ offset: true }),
    status: z.object({ short: z.string() }).passthrough().optional() }).passthrough(),
  league: z.object({ id: z.number().int().positive(), name: z.string().min(1), season: z.number().int() }).passthrough(),
  teams: z.object({ home: z.object({ id: z.number().int().positive(), name: z.string().min(1) }).passthrough(),
    away: z.object({ id: z.number().int().positive(), name: z.string().min(1) }).passthrough() }).passthrough(),
  goals: z.object({ home: z.number().int().nonnegative().nullable(), away: z.number().int().nonnegative().nullable() }).passthrough().optional(),
}).passthrough();
const apiFootballFixturesResponseSchema = z.object({ response: z.array(apiFootballFixtureSchema) }).passthrough();
const apiFootballTeamStatsSchema = z.object({
  fixtures: z.object({ played: z.object({ home: z.number().int().nonnegative().nullable().optional(), away: z.number().int().nonnegative().nullable().optional() }).passthrough() }).passthrough(),
  goals: z.object({
    "for": z.object({ average: z.object({ home: z.union([z.string(), z.number()]).nullable().optional(), away: z.union([z.string(), z.number()]).nullable().optional() }).passthrough() }).passthrough(),
    against: z.object({ average: z.object({ home: z.union([z.string(), z.number()]).nullable().optional(), away: z.union([z.string(), z.number()]).nullable().optional() }).passthrough() }).passthrough(),
  }).passthrough(),
}).passthrough();
const apiFootballTeamStatsResponseSchema = z.object({ response: apiFootballTeamStatsSchema }).passthrough();
const typedOutputSchema = z.object({
  signingAddress: addressSchema,
  timestamp: z.string(),
  nonce: z.string(),
  typedData: typedDataSchema,
  requestWalletSignIntent: requestWalletSignIntentSchema,
}).strict();
const walletTypeSchema = z.enum(["EOA", "PROXY", "SAFE", "DEPOSIT_WALLET"]);
const orderTypeSchema = z.enum(["FAK", "FOK"]);
const preparedOrderBaseSchema = z.object({
  market: z.object({
    id: z.string().regex(/^[0-9]{1,32}$/), conditionId: z.string().regex(/^0x[0-9a-fA-F]{64}$/), outcome: z.string(),
  }).strict(),
  wallet: z.object({
    type: walletTypeSchema, makerAddress: addressSchema, signingAddress: addressSchema,
    orderSignerAddress: addressSchema, signatureType: z.number().int().min(0).max(3),
  }).strict(),
  order: z.object({
    salt: z.string().regex(/^(0|[1-9][0-9]{0,77})$/), timestamp: z.string().regex(/^[0-9]{1,16}$/), assetId: decimalIdSchema, side: sideSchema,
    price: z.string(), size: z.string(), orderType: orderTypeSchema, makerAmount: z.string(),
    takerAmount: z.string(), metadata: z.string(), builder: z.string(),
  }).strict(),
}).strict();
const preparedOrderSchema = preparedOrderBaseSchema.extend({ typedData: typedDataSchema }).strict();

type PreparedOrder = z.infer<typeof preparedOrderSchema>;
type TypedPayload = z.infer<typeof typedDataSchema>;
const clobAuthSchema = z.object({
  timestamp: z.string().regex(/^[0-9]{1,16}$/), nonce: z.string().regex(/^(0|[1-9][0-9]{0,77})$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
}).strict();
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
  status: orderLifecycleSchema, orderId: z.string().nullable(), orderType: orderTypeSchema,
  requestedSize: z.string(), filledSize: z.string().nullable(), remainingSize: z.string().nullable(),
  tradeIds: z.array(z.string()), message: z.string(), errorCode: z.string().regex(/^PS_[A-Z_]+$/).nullable().default(null),
  httpStatus: z.number().int().min(100).max(599).optional(),
}).strict();
const chainBalanceSchema = z.object({
  baseUnits: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
  formatted: z.string().nullable(), decimals: z.number().int(),
  status: z.enum(["NONZERO", "ZERO", "UNKNOWN"]),
}).strict();
const operatorApprovalSchema = z.object({
  tokenLedger: z.enum(["Conditional Tokens", "PositionManager"]), operator: addressSchema,
  approved: z.boolean().nullable(), status: z.enum(["PRESENT", "MISSING", "UNKNOWN"]),
}).strict();
const tradingApprovalSchema = z.object({
  kind: z.enum(["PUSD_ALLOWANCE", "ERC1155_OPERATOR"]).nullable(),
  target: addressSchema.nullable(), tokenLedger: z.enum(["Conditional Tokens", "PositionManager"]).nullable(),
  allowanceBaseUnits: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
  status: z.enum(["PRESENT", "MISSING", "UNKNOWN"]),
}).strict();
const tradingReadinessSchema = z.object({
  status: z.enum(["CHECKS_PRESENT", "ACTION_REQUIRED", "UNKNOWN"]),
  wallet: z.object({ address: addressSchema, type: walletTypeSchema, addressRole: z.literal("ACCOUNT_WALLET") }).strict(),
  chainId: z.literal(137), observedAt: z.string().datetime(),
  pUsdBalance: chainBalanceSchema, polBalance: chainBalanceSchema.nullable(),
  approval: tradingApprovalSchema,
  eoaTradingEligibility: z.enum(["UNKNOWN", "NOT_APPLICABLE"]),
  reason: z.string(), nextAction: z.string().nullable(),
}).strict();
const transactionPreviewSchema = z.object({
  from: addressSchema, to: addressSchema, value: z.literal("0"), data: z.string().regex(/^0x[0-9a-fA-F]+$/),
}).strict();
const preparedRedeemSchema = z.object({
  status: z.enum(["PREPARED", "UNRESOLVED", "NO_POSITION", "UNKNOWN", "UNSUPPORTED"]),
  conditionId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  wallet: z.object({ address: addressSchema, type: walletTypeSchema, addressRole: z.literal("POSITION_OWNER") }).strict(),
  market: z.object({ marketId: z.string().nullable(), question: z.string().nullable(), version: z.enum(["v1", "v2"]).nullable(), negRisk: z.boolean().nullable() }).strict(),
  resolution: z.enum(["RESOLVED", "UNRESOLVED", "UNKNOWN"]),
  positionLedger: z.enum(["Conditional Tokens", "NegRisk Adapter", "PositionManager", "UNKNOWN"]),
  positions: z.array(z.object({
    outcome: z.string(), tokenId: decimalIdSchema, balanceBaseUnits: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
    ownership: z.enum(["HELD", "NOT_HELD", "UNKNOWN"]),
  }).strict()),
  routeApproval: operatorApprovalSchema.nullable(),
  transactionPreview: z.array(transactionPreviewSchema),
  execution: z.enum(["EXTERNAL_ACTION_REQUIRED", "NOT_READY", "UNSUPPORTED"]),
  missingRequirements: z.array(z.string()), unknownRequirements: z.array(z.string()), nextActions: z.array(z.string()),
  errorCode: z.enum(["PS_MARKET_NOT_FOUND", "PS_MARKET_DATA_UNAVAILABLE", "PS_MARKET_UNSUPPORTED", "PS_CHAIN_READ_UNAVAILABLE"]).nullable(),
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
  | { ok: true; data: unknown; httpStatus: number }
  | { ok: false; reason: string; httpStatus?: number };

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
  let httpStatus: number | undefined;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(2_500),
    });
    httpStatus = response.status;
    if (!response.ok) return { ok: false, reason: footballDataHttpReason(response.status), httpStatus: response.status };
    const body = await boundedResponseText(response, 1_000_000);
    try {
      const data: unknown = JSON.parse(body);
      return { ok: true, data, httpStatus: response.status };
    } catch {
      return { ok: false, reason: "football-data.org returned invalid JSON.", httpStatus: response.status };
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error && error.message === "response_too_large"
        ? "football-data.org response exceeded the 1 MB limit."
        : error instanceof DOMException && error.name === "TimeoutError"
          ? "football-data.org request timed out."
          : "football-data.org request failed before receiving a response.",
      ...(httpStatus === undefined ? {} : { httpStatus }),
    };
  }
}

async function getApiFootballJson(url: string): Promise<ProviderFetchResult> {
  let httpStatus: number | undefined;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(2_500),
    });
    httpStatus = response.status;
    if (response.status === 204) return { ok: false, reason: "API-Football returned HTTP 204 with no data for this endpoint or competition.", httpStatus: response.status };
    if (!response.ok) return { ok: false, reason: `API-Football returned HTTP ${response.status}. Check the host-scoped API key, endpoint access, and account coverage.`, httpStatus: response.status };
    const body = await boundedResponseText(response, 1_000_000);
    try {
      const data: unknown = JSON.parse(body);
      const envelope = z.object({ errors: z.unknown().optional() }).passthrough().safeParse(data);
      const errors = envelope.success ? envelope.data.errors : undefined;
      const hasErrors = Array.isArray(errors) ? errors.length > 0
        : typeof errors === "object" && errors !== null ? Object.keys(errors).length > 0
          : errors !== undefined && errors !== null && errors !== "";
      if (hasErrors) return { ok: false, reason: "API-Football reported an endpoint error; check credentials, parameters, competition coverage, and account limits.", httpStatus: response.status };
      return { ok: true, data, httpStatus: response.status };
    } catch {
      return { ok: false, reason: "API-Football returned invalid JSON.", httpStatus: response.status };
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.message === "response_too_large"
      ? "API-Football response exceeded the 1 MB limit."
      : error instanceof DOMException && error.name === "TimeoutError"
        ? "API-Football request timed out."
        : "API-Football request failed before receiving a response.", ...(httpStatus === undefined ? {} : { httpStatus }) };
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

const API_FOOTBALL_COMPETITION_IDS = { PL: 39, PD: 140, SA: 135, CL: 2 } as const;

type SoccerLeague = keyof typeof SPORTS_COMPETITIONS;

const footballTeamSchema = z.object({ id: z.number().int().positive(), name: z.string().min(1) }).passthrough();
const footballDataMatchSchema = z.object({
  id: z.number().int().positive(), utcDate: z.string().datetime(), status: z.string().min(1),
  lastUpdated: z.string().datetime().nullable().optional(),
  season: z.object({ startDate: z.string().nullable().optional(), endDate: z.string().nullable().optional() }).passthrough().optional(),
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

function normalizedProviderName(value: string): string {
  return value.toLocaleLowerCase("en-US").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

function normalizedTeamName(value: string): string {
  return normalizedProviderName(value).replace(/(?:footballclub|soccerclub|fc|afc|cf|sc)$/g, "");
}

function providerCompetitionMatches(league: SoccerLeague, providerName: string): boolean {
  const name = normalizedProviderName(providerName);
  const accepted = {
    PL: ["premierleague"],
    PD: ["laliga", "spanishla", "primera"],
    SA: ["seriea"],
    CL: ["uefachampionsleague", "championsleague"],
  }[league];
  return accepted.includes(name);
}

function resolveApiFootballSeason(league: SoccerLeague, date: string, evidence?: { startDate?: string | null; endDate?: string | null }): number | null {
  if (!validDate(date)) return null;
  const month = Number(date.slice(5, 7));
  const year = Number(date.slice(0, 4));
  const seasonStartMonth = league === "CL" ? 7 : 8;
  const calendarSeason = month >= seasonStartMonth ? year : month <= 5 ? year - 1 : null;
  const startDate = evidence?.startDate ?? undefined;
  const endDate = evidence?.endDate ?? undefined;
  if ((startDate !== undefined && !validDate(startDate)) || (endDate !== undefined && !validDate(endDate))) return null;
  if (startDate !== undefined && endDate !== undefined) {
    return startDate <= endDate && startDate <= date && date <= endDate ? Number(startDate.slice(0, 4)) : null;
  }
  if (calendarSeason === null) return null;
  if (startDate !== undefined && (startDate > date || Number(startDate.slice(0, 4)) !== calendarSeason)) return null;
  if (endDate !== undefined && (date > endDate || Number(endDate.slice(0, 4)) !== calendarSeason + 1)) return null;
  return calendarSeason;
}

function apiFootballFixtureUrl(league: SoccerLeague, season: number | null, date: string): string {
  return apiFootballUrl("fixtures", {
    league: String(API_FOOTBALL_COMPETITION_IDS[league]),
    ...(season === null ? {} : { season: String(season) }),
    date, timezone: "UTC",
  });
}

function apiFootballUrl(path: string, parameters: Record<string, string>): string {
  const url = new URL(`${API_FOOTBALL_API}/${path}`);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.toString();
}

function numericAverage(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function getApiFootballTeamStatistics(match: z.infer<typeof apiFootballFixtureSchema>, fixtureDate: string) {
  const cutoffDate = addDays(fixtureDate, -1);
  const homeStatsUrl = apiFootballUrl("teams/statistics", {
    league: String(match.league.id), team: String(match.teams.home.id), season: String(match.league.season), date: cutoffDate,
  });
  const awayStatsUrl = apiFootballUrl("teams/statistics", {
    league: String(match.league.id), team: String(match.teams.away.id), season: String(match.league.season), date: cutoffDate,
  });
  const [homeResponse, awayResponse] = await Promise.all([getApiFootballJson(homeStatsUrl), getApiFootballJson(awayStatsUrl)]);
  const mapStats = (response: ProviderFetchResult) => {
    if (!response.ok) return { stats: null, reason: response.reason, httpStatus: response.httpStatus ?? null };
    const parsed = apiFootballTeamStatsResponseSchema.safeParse(response.data);
    if (!parsed.success) return { stats: null, reason: "API-Football returned an unexpected team-statistics response shape.", httpStatus: response.httpStatus };
    return { stats: parsed.data.response, reason: null, httpStatus: response.httpStatus };
  };
  const homeResponseStats = mapStats(homeResponse);
  const awayResponseStats = mapStats(awayResponse);
  const homeStats = homeResponseStats.stats ? {
    providerTeamId: String(match.teams.home.id), playedAtHome: homeResponseStats.stats.fixtures.played.home ?? 0,
    goalsForAverage: numericAverage(homeResponseStats.stats.goals.for.average.home),
    goalsAgainstAverage: numericAverage(homeResponseStats.stats.goals.against.average.home),
  } : null;
  const awayStats = awayResponseStats.stats ? {
    providerTeamId: String(match.teams.away.id), playedAway: awayResponseStats.stats.fixtures.played.away ?? 0,
    goalsForAverage: numericAverage(awayResponseStats.stats.goals.for.average.away),
    goalsAgainstAverage: numericAverage(awayResponseStats.stats.goals.against.average.away),
  } : null;
  const complete = homeStats !== null && awayStats !== null && homeStats.playedAtHome > 0 && awayStats.playedAway > 0
    && homeStats.goalsForAverage !== null && homeStats.goalsAgainstAverage !== null
    && awayStats.goalsForAverage !== null && awayStats.goalsAgainstAverage !== null;
  const observedAt = new Date().toISOString();
  const sources = [
    { provider: "API-Football" as const, purpose: "TEAM_STATISTICS" as const, url: homeStatsUrl, observedAt,
      teamProviderId: String(match.teams.home.id), teamName: match.teams.home.name,
      availability: homeStats ? "AVAILABLE" as const : "UNAVAILABLE" as const, httpStatus: homeResponseStats.httpStatus, reason: homeResponseStats.reason },
    { provider: "API-Football" as const, purpose: "TEAM_STATISTICS" as const, url: awayStatsUrl, observedAt,
      teamProviderId: String(match.teams.away.id), teamName: match.teams.away.name,
      availability: awayStats ? "AVAILABLE" as const : "UNAVAILABLE" as const, httpStatus: awayResponseStats.httpStatus, reason: awayResponseStats.reason },
  ];
  return {
    availability: complete ? "AVAILABLE" as const : "UNAVAILABLE" as const,
    reason: complete ? null : [homeResponseStats.reason, awayResponseStats.reason].filter((reason): reason is string => reason !== null).join(" ")
      || "API-Football did not supply positive venue sample counts and goals-for/against averages for both teams.",
    homeStats, awayStats, sources,
  };
}

async function getApiFootballEnrichment(fixture: z.infer<typeof soccerFixtureSchema>, league: SoccerLeague,
  seasonEvidence?: { startDate?: string | null; endDate?: string | null }) {
  const fixtureDate = fixture.kickoffUtc.slice(0, 10);
  const season = resolveApiFootballSeason(league, fixtureDate, seasonEvidence);
  const fixturesUrl = apiFootballFixtureUrl(league, season, fixtureDate);
  const observedAt = new Date().toISOString();
  const unavailable = (reason: string) => ({
    availability: "UNAVAILABLE" as const, reason, sourceUrl: fixturesUrl, observedAt,
    matchIdentity: null, homeStats: null, awayStats: null,
    sources: [{ provider: "API-Football" as const, purpose: "MATCH_ENRICHMENT" as const, url: fixturesUrl, observedAt, availability: "UNAVAILABLE" as const, reason }],
  });
  if (season === null) return unavailable("API-Football enrichment was not requested because football-data.org season metadata was invalid or conflicting, or the fixture date is ambiguous under the competition calendar.");
  const listing = await getApiFootballJson(fixturesUrl);
  if (!listing.ok) return unavailable(listing.reason);
  const parsedListing = apiFootballFixturesResponseSchema.safeParse(listing.data);
  if (!parsedListing.success) return unavailable("API-Football returned an unexpected fixtures response shape.");
  const homeName = normalizedTeamName(fixture.homeTeam);
  const awayName = normalizedTeamName(fixture.awayTeam);
  const targetKickoff = Date.parse(fixture.kickoffUtc);
  const candidates = parsedListing.data.response.filter((entry) =>
    entry.league.id === API_FOOTBALL_COMPETITION_IDS[league] && entry.league.season === season
      && providerCompetitionMatches(league, entry.league.name)
      && normalizedTeamName(entry.teams.home.name) === homeName
      && normalizedTeamName(entry.teams.away.name) === awayName
      && Date.parse(entry.fixture.date) === targetKickoff);
  if (candidates.length !== 1) {
    return unavailable(candidates.length === 0
      ? "API-Football did not return a fixture matching the competition, both team names, and exact UTC kickoff."
      : "API-Football returned multiple fixtures matching the competition, teams, and kickoff; enrichment was not joined.");
  }
  const match = candidates[0];
  if (!match) return unavailable("API-Football fixture matching failed.");
  const matchIdentity = {
    providerFixtureId: String(match.fixture.id), providerLeagueId: String(match.league.id), providerSeason: match.league.season,
    competition: match.league.name, homeTeam: match.teams.home.name, homeTeamProviderId: String(match.teams.home.id),
    awayTeam: match.teams.away.name, awayTeamProviderId: String(match.teams.away.id), kickoffUtc: new Date(match.fixture.date).toISOString(),
  };
  const statistics = await getApiFootballTeamStatistics(match, fixtureDate);
  const sources = [
    { provider: "API-Football" as const, purpose: "MATCH_ENRICHMENT" as const, url: fixturesUrl, observedAt,
      availability: "AVAILABLE" as const, httpStatus: listing.httpStatus, reason: null },
    ...statistics.sources,
  ];
  return {
    availability: statistics.availability, reason: statistics.reason,
    sourceUrl: fixturesUrl, observedAt, matchIdentity, homeStats: statistics.homeStats, awayStats: statistics.awayStats,
    sources,
  };
}

function apiFootballFallbackCoverage(requestedDateFrom: string, requestedDateTo: string, queriedDate: string) {
  const datesNotQueried: string[] = [];
  for (let date = requestedDateFrom; date <= requestedDateTo; date = addDays(date, 1)) {
    if (date !== queriedDate) datesNotQueried.push(date);
  }
  const status = datesNotQueried.length === 0 ? "COMPLETE" as const : "PARTIAL" as const;
  return {
    requestedDateFrom, requestedDateTo, queriedDate, datesNotQueried, status,
    continuationInstruction: status === "COMPLETE"
      ? `The request covered every date in the requested range using ${queriedDate}; check provider availability separately to determine whether usable data was returned.`
      : `This fallback queried only ${queriedDate}. Call research_soccer with date set to each of ${datesNotQueried.join(", ")} and days=0 to continue; those dates are not covered by this result.`,
  };
}

async function getApiFootballFallback(league: SoccerLeague, date: string, requestedDateFrom: string, requestedDateTo: string,
  fixtureIdentity?: z.infer<typeof fixtureIdentitySchema>, exactFixtureRequested = false) {
  const season = resolveApiFootballSeason(league, date);
  const sourceUrl = apiFootballFixtureUrl(league, season, date);
  const observedAt = new Date().toISOString();
  const coverage = apiFootballFallbackCoverage(requestedDateFrom, requestedDateTo, date);
  const unavailable = (reason: string, httpStatus: number | null, verificationStatus: z.infer<typeof fixtureEvidenceStatusSchema> = "UNVERIFIED") => ({
    diagnostic: {
      provider: "API-Football" as const, availability: "UNAVAILABLE" as const, reason, sourceUrl, observedAt, httpStatus,
      verificationStatus, confidenceCategory: "LOW" as const,
      confidenceReason: "No unique, independently corroborated target fixture was established.",
      coverage,
    },
    fixtures: [] as z.infer<typeof providerQualifiedFixtureSchema>[],
  });
  if (season === null) return unavailable("API-Football fallback was not requested because the competition season could not be established safely from the requested date.", null);
  const listing = await getApiFootballJson(sourceUrl);
  if (!listing.ok) return unavailable(listing.reason, listing.httpStatus ?? null);
  const parsed = apiFootballFixturesResponseSchema.safeParse(listing.data);
  if (!parsed.success) return unavailable("API-Football returned an unexpected fixtures response shape.", listing.httpStatus);
  const dayFixtures = parsed.data.response.filter((fixture) => fixture.league.id === API_FOOTBALL_COMPETITION_IDS[league]
    && fixture.league.season === season && providerCompetitionMatches(league, fixture.league.name)
    && new Date(fixture.fixture.date).toISOString().slice(0, 10) === date);
  if (dayFixtures.length === 0) return unavailable("API-Football returned a valid response with no fixtures for the requested competition and UTC date.", listing.httpStatus);

  let selected: z.infer<typeof apiFootballFixtureSchema>[] = [];
  let verificationStatus: z.infer<typeof fixtureEvidenceStatusSchema> = "PARTIAL";
  let confidenceReason = "The fixture is attributed to one provider only; it has not been independently corroborated.";
  if (fixtureIdentity) {
    const targetKickoff = Date.parse(fixtureIdentity.kickoffUtc);
    selected = dayFixtures.filter((fixture) => normalizedTeamName(fixture.teams.home.name) === normalizedTeamName(fixtureIdentity.homeTeam)
      && normalizedTeamName(fixture.teams.away.name) === normalizedTeamName(fixtureIdentity.awayTeam)
      && Date.parse(fixture.fixture.date) === targetKickoff);
    if (selected.length !== 1) return unavailable(selected.length === 0
      ? "No API-Football fixture matched the supplied competition, home and away teams, and exact UTC kickoff."
      : "Multiple API-Football fixtures matched the supplied identity; no fixture was selected.", listing.httpStatus,
    selected.length > 1 ? "CONFLICTED" : "UNVERIFIED");
  } else if (exactFixtureRequested) {
    selected = dayFixtures;
    verificationStatus = "UNVERIFIED";
    confidenceReason = "The football-data.org fixture ID is a separate namespace; exact matching requires team names and UTC kickoff.";
  } else {
    selected = dayFixtures;
  }

  const fixtures: z.infer<typeof providerQualifiedFixtureSchema>[] = [];
  for (const fixture of selected) {
    const exact = fixtureIdentity !== undefined;
    const statistics = exact ? await getApiFootballTeamStatistics(fixture, date) : null;
    const kickoffUtc = new Date(fixture.fixture.date).toISOString();
    fixtures.push(providerQualifiedFixtureSchema.parse({
      provider: "API-Football", providerFixtureId: String(fixture.fixture.id), providerLeagueId: String(fixture.league.id),
      providerSeason: fixture.league.season, competition: fixture.league.name,
      homeTeam: fixture.teams.home.name, providerHomeTeamId: String(fixture.teams.home.id),
      awayTeam: fixture.teams.away.name, providerAwayTeamId: String(fixture.teams.away.id), kickoffUtc,
      status: fixture.fixture.status?.short ?? null, homeScore: fixture.goals?.home ?? null, awayScore: fixture.goals?.away ?? null,
      observedAt, sourceUrl, verificationStatus: exact ? "PARTIAL" : verificationStatus,
      confidenceCategory: "LOW", confidenceReason: exact ? confidenceReason : exactFixtureRequested
        ? "Date and competition match, but this candidate was not matched to the requested fixture identity."
        : "API-Football is the sole provider for this fixture evidence; no independent corroboration was supplied.",
      statisticsAvailability: statistics?.availability ?? "UNAVAILABLE",
      statisticsReason: statistics?.reason ?? (exactFixtureRequested
        ? "Team statistics were not requested because the API-Football candidate was not matched to an exact fixture identity."
        : "Team statistics were not requested during date-scoped fixture discovery."),
      homeStats: statistics?.homeStats ?? null, awayStats: statistics?.awayStats ?? null,
      sources: [
        { provider: "API-Football", purpose: "FIXTURES_AND_RESULTS", url: sourceUrl, observedAt, availability: "AVAILABLE", httpStatus: listing.httpStatus, reason: null },
        ...(statistics?.sources.map((source) => ({ ...source, purpose: "TEAM_STATISTICS" as const })) ?? []),
      ],
    }));
  }
  const resultVerification: z.infer<typeof fixtureEvidenceStatusSchema> = fixtureIdentity ? "PARTIAL" : verificationStatus;
  const missingStats = fixtures.find((fixture) => fixture.statisticsAvailability === "UNAVAILABLE")?.statisticsReason;
  const resultReason = fixtureIdentity ? `A unique API-Football fixture matched the supplied identity, but it is not cross-provider verified.${missingStats ? ` Statistics: ${missingStats}` : ""}` : exactFixtureRequested
    ? "API-Football candidates are date-scoped only; the football-data.org fixture ID was not used to guess a match."
    : "Fixtures are API-Football-only evidence and are not cross-provider verified.";
  return {
    diagnostic: {
      provider: "API-Football" as const, availability: "AVAILABLE" as const, reason: resultReason, sourceUrl, observedAt,
      httpStatus: listing.httpStatus, verificationStatus: resultVerification, confidenceCategory: "LOW" as const,
      confidenceReason: fixtureIdentity ? confidenceReason : "One provider supplied these fixtures; no independent source corroborated the target identity.",
      coverage,
    },
    fixtures,
  };
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
  league: SoccerLeague; date?: string; days: number; fixtureId?: string; fixtureIdentity?: z.infer<typeof fixtureIdentitySchema>;
  limit: number; includeApiFootball: boolean;
}): Promise<z.infer<typeof soccerResearchOutputSchema>> {
  const definition = SPORTS_COMPETITIONS[input.league];
  const startDate = input.date ?? input.fixtureIdentity?.kickoffUtc.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const endDate = addDays(startDate, input.days);
  const identityDate = input.fixtureIdentity?.kickoffUtc.slice(0, 10);
  if (input.date !== undefined && identityDate !== undefined && (identityDate < startDate || identityDate > endDate)) {
    throw new Error(`PS_FIXTURE_IDENTITY_DATE_OUT_OF_RANGE: fixtureIdentity kickoff date ${identityDate} is outside the requested range ${startDate} through ${endDate}.`);
  }
  const observedAt = new Date().toISOString();
  const fixturesUrl = input.fixtureId
    ? footballDataUrl(`matches/${input.fixtureId}`)
    : footballDataUrl(`competitions/${input.league}/matches`, { dateFrom: startDate, dateTo: endDate });
  const fixturesResponse = await getProviderJson(fixturesUrl);
  const sources: z.infer<typeof soccerSourceSchema>[] = [{
    provider: "football-data.org", purpose: input.fixtureId ? "EXACT_FIXTURE" : "FIXTURES_AND_RESULTS",
    url: fixturesUrl, observedAt: new Date().toISOString(), availability: "UNAVAILABLE", httpStatus: null, reason: null,
  }];
  const unavailable = (reason: string, season: string | null = null) => soccerResearchOutputSchema.parse({
    availability: "UNAVAILABLE", reason, league: input.league, competition: definition.name,
    provider: "football-data.org", sources, observedAt, season, leagueProviderId: input.league,
    coverage: "UNAVAILABLE", returnedEventCount: 0, fixtures: [],
  });
  const fallbackAfterPrimaryFailure = async (reason: string, httpStatus: number | null) => {
    const primarySource = sources[0];
    if (primarySource) {
      primarySource.availability = "UNAVAILABLE";
      primarySource.httpStatus = httpStatus;
      primarySource.reason = reason;
    }
    const fallbackDate = identityDate ?? startDate;
    const fallback = await getApiFootballFallback(input.league, fallbackDate, startDate, endDate, input.fixtureIdentity, input.fixtureId !== undefined);
    const hasFallbackFixtures = fallback.fixtures.length > 0;
    const partialCoverage = fallback.diagnostic.coverage.status === "PARTIAL";
    sources.push({
      provider: "API-Football", purpose: "FIXTURES_AND_RESULTS", url: fallback.diagnostic.sourceUrl,
      observedAt: fallback.diagnostic.observedAt, availability: fallback.diagnostic.availability,
      httpStatus: fallback.diagnostic.httpStatus, returnedResultCount: fallback.fixtures.length, reason: fallback.diagnostic.reason,
    });
    return soccerResearchOutputSchema.parse({
      availability: hasFallbackFixtures ? "AVAILABLE" : "UNAVAILABLE",
      reason: hasFallbackFixtures ? partialCoverage ? fallback.diagnostic.coverage.continuationInstruction : null
        : `${reason} API-Football fallback: ${fallback.diagnostic.reason} ${fallback.diagnostic.coverage.continuationInstruction}`,
      league: input.league, competition: definition.name, provider: "football-data.org", sources, observedAt,
      season: null, leagueProviderId: input.league, ...(hasFallbackFixtures ? { resultProvider: "API-Football" as const } : {}),
      coverage: hasFallbackFixtures ? partialCoverage ? "PARTIAL_FALLBACK_MATCHES" as const : "FALLBACK_MATCHES" as const : "UNAVAILABLE" as const,
      returnedEventCount: fallback.fixtures.length, fixtures: [], fallbackProvider: fallback.diagnostic,
      fallbackFixtures: fallback.fixtures,
    });
  };
  if (!fixturesResponse.ok) return fallbackAfterPrimaryFailure(fixturesResponse.reason, fixturesResponse.httpStatus ?? null);

  let matches: z.infer<typeof footballDataMatchSchema>[];
  if (input.fixtureId) {
    const parsed = footballDataMatchSchema.safeParse(fixturesResponse.data);
    if (!parsed.success) return fallbackAfterPrimaryFailure("football-data.org returned an unexpected exact-fixture response shape.", fixturesResponse.httpStatus);
    if (String(parsed.data.id) !== input.fixtureId || parsed.data.competition?.code !== input.league) {
      return fallbackAfterPrimaryFailure("football-data.org exact-fixture response did not match the requested fixture ID and competition.", fixturesResponse.httpStatus);
    }
    matches = [parsed.data];
  } else {
    const parsed = footballDataMatchesSchema.safeParse(fixturesResponse.data);
    if (!parsed.success) return fallbackAfterPrimaryFailure("football-data.org returned an unexpected fixtures response shape.", fixturesResponse.httpStatus);
    if (parsed.data.matches.length === 0) {
      const primarySource = sources[0];
      if (primarySource) {
        primarySource.availability = "AVAILABLE";
        primarySource.httpStatus = fixturesResponse.httpStatus;
        primarySource.returnedResultCount = 0;
        primarySource.reason = "Valid HTTP response contained zero fixtures; no provider fallback was attempted.";
      }
      return unavailable("football-data.org returned a valid empty fixture list for this competition and date window.");
    }
    matches = parsed.data.matches;
  }
  matches = matches.filter((match) => match.competition?.code === input.league);
  if (!input.fixtureId) matches = matches.filter((match) => match.utcDate.slice(0, 10) >= startDate && match.utcDate.slice(0, 10) <= endDate);
  if (matches.length === 0) return fallbackAfterPrimaryFailure("football-data.org response contained no fixtures matching the requested competition and date window.", fixturesResponse.httpStatus);
  const primarySource = sources[0];
  if (primarySource) {
    primarySource.availability = "AVAILABLE";
    primarySource.httpStatus = fixturesResponse.httpStatus;
    primarySource.returnedResultCount = matches.length;
  }

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
  if (fixtures.length === 0) return fallbackAfterPrimaryFailure("football-data.org response did not match the supported fixture schema.", fixturesResponse.httpStatus);
  if (exactMatch) {
    const exactFixture = fixtures.find((fixture) => fixture.fixtureId === String(exactMatch.id));
    if (exactFixture) {
      exactFixture.formSources = sources.filter((source) => source.provider === "football-data.org" && source.purpose === "TEAM_FORM")
        .map((source) => ({ provider: "football-data.org" as const, url: source.url, observedAt: source.observedAt }));
      if (input.includeApiFootball) {
        const enrichment = await getApiFootballEnrichment(exactFixture, input.league, exactMatch.season);
        exactFixture.apiFootball = enrichment;
        sources.push(...enrichment.sources);
      }
    }
  }
  return soccerResearchOutputSchema.parse({
    availability: "AVAILABLE", reason: null, league: input.league, competition: definition.name,
    provider: "football-data.org", resultProvider: "football-data.org", sources, observedAt, season: null,
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

function blockedSigner(signerAddress: string, capture?: (payload: TypedDataPayload) => void): Signer {
  const blocked = () => { throw new Error("PS_EXTERNAL_SIGNING_REQUIRED: PayBox must sign outside the plugin."); };
  return {
    getAddress: async () => expectEvmAddress(signerAddress),
    signTypedData: async (payload) => { capture?.(payload); return blocked(); },
    signMessage: async () => blocked(), sendTransaction: async () => blocked(),
  };
}

async function clobAuthTypedData(signer: Address, timestamp: string | undefined, nonce: string) {
  if (!Number.isSafeInteger(Number(nonce))) throw new Error("PS_AUTH_NONCE_INVALID: SDK nonce must be a safe nonnegative integer.");
  let payload: TypedDataPayload | undefined;
  try {
    await createSecureClient({ wallet: signer, nonce: Number(nonce), signer: blockedSigner(signer, (value) => { payload = value; }) });
  } catch (error) { if (!payload) throw error; }
  if (!payload) throw new Error("PS_PROVIDER_INVALID: SDK did not request authentication signing.");
  return timestamp === undefined ? payload : { ...payload, message: { ...payload.message, timestamp } };
}

function standardOrderPayload(prepared: PreparedOrder) {
  const payload = prepared.typedData;
  return { ...payload, primaryType: "Order", message: payload.primaryType === "TypedDataSign"
    ? z.record(z.string(), z.unknown()).parse(payload.message.contents) : payload.message };
}

function signingPayload(prepared: PreparedOrder) { return viemPayload(prepared.typedData); }
function viemPayload(payload: TypedPayload) {
  return { ...payload, domain: { ...payload.domain, verifyingContract: payload.domain.verifyingContract === undefined ? undefined : address(payload.domain.verifyingContract) } };
}

function wireTypedData(payload: unknown): TypedPayload {
  const serialized: unknown = JSON.parse(JSON.stringify(payload, (_key: string, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  ));
  return typedDataSchema.parse(serialized);
}

// The public SDK exposes no finalizer for a signature returned in a fresh sandbox.
function wrapDepositWalletSignature(prepared: PreparedOrder, signature: Hex): Hex {
  const payload = standardOrderPayload(prepared);
  const fields = payload.types.Order;
  if (!fields) throw new Error("PS_ORDER_INVALID: SDK Order fields are missing.");
  const orderType = `Order(${fields.map(({ type, name }) => `${type} ${name}`).join(",")})`;
  return concatHex([
    signature, domainSeparator({ domain: viemPayload(payload).domain }),
    hashStruct({ types: payload.types, primaryType: "Order", data: payload.message }),
    toHex(orderType), toHex(orderType.length, { size: 2 }),
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

async function getMarketFeeInfo(conditionId: string): Promise<{ rate: string; exponent: number }> {
  const info = await runSdk(() => fetchMarketInfo(createPolymarketClient(), { conditionId })).catch((error: unknown) => {
    const failure = clobRequestFailure(error, "PS_PROVIDER_INVALID", "Official SDK market metadata could not be read.");
    throw new ClobRequestError(failure.code, failure.message, failure.httpStatus);
  });
  const rate = String(info.feeInfo.rate);
  if (info.feeInfo.rate < 0 || info.feeInfo.rate > 1 || !Number.isInteger(info.feeInfo.exponent) || info.feeInfo.exponent < 0 || info.feeInfo.exponent > 6) {
    throw new Error("PS_FEE_INVALID: SDK fee metadata cannot support the informational quote estimate.");
  }
  try { toUnits(rate, 6, 6); }
  catch { throw new Error("PS_FEE_INVALID: Fee rate exceeds supported exact decimal precision."); }
  return { rate, exponent: info.feeInfo.exponent };
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
    recovered = await recoverTypedDataAddress({ ...signingPayload(prepared), signature });
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

type ClobCredentials = Awaited<ReturnType<typeof createSecureClient>>;

class ClobRequestError extends Error {
  constructor(readonly code: string, readonly safeMessage: string, readonly httpStatus?: number) {
    super(`${code}: ${safeMessage}`);
    this.name = "ClobRequestError";
  }
}

function clobRequestFailure(error: unknown, fallbackCode: string, fallbackMessage: string): {
  code: string; message: string; httpStatus?: number;
} {
  if (error instanceof RequestRejectedError) {
    const failure = clobPrivateHttpFailure(error.status);
    return { ...failure, httpStatus: error.status };
  }
  if (error instanceof ClobRequestError) {
    return {
      code: error.code,
      message: error.safeMessage,
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    };
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.cause instanceof Error && error.cause.name === "TimeoutError")) {
    return { code: "PS_PROVIDER_TIMEOUT", message: "Polymarket CLOB request timed out." };
  }
  if (error instanceof Error && error.message === "response_too_large") {
    return { code: "PS_RESPONSE_TOO_LARGE", message: "Polymarket CLOB response exceeded the processing limit." };
  }
  if (error instanceof Error) {
    const match = /^(PS_[A-Z_]+):\s*(.*)$/.exec(error.message);
    if (match?.[1] !== undefined && match[2] !== undefined) return { code: match[1], message: match[2] };
  }
  return { code: fallbackCode, message: fallbackMessage };
}

async function deriveClobCredentials(auth: z.infer<typeof clobAuthSchema>, signerAddress: string, wallet = signerAddress): Promise<ClobCredentials> {
  return runSdk(async () => {
    const signer = address(signerAddress);
    const payload = await clobAuthTypedData(signer, auth.timestamp, auth.nonce);
    let recovered: Address;
    try { recovered = await recoverTypedDataAddress({ ...payload, signature: signatureHex(auth.signature) }); }
    catch { throw new Error("PS_AUTH_SIGNATURE_INVALID: Prepare and sign a new ClobAuth for the owner signer."); }
    if (recovered?.toLowerCase() !== signer.toLowerCase()) throw new Error("PS_AUTH_WALLET_MISMATCH: ClobAuth does not match the owner signer.");
    const publicClient = createPolymarketClient();
    const request = { address: expectEvmAddress(signer), nonce: Number(auth.nonce), timestamp: Number(auth.timestamp), signature: expectEvmSignature(auth.signature) };
    let credentials;
    try { credentials = await createOrDeriveApiKey(publicClient, request); }
    catch (error) {
      if (error instanceof RequestRejectedError && error.status === 401) throw new ClobRequestError("PS_CLOB_AUTH_REJECTED", "Polymarket rejected authentication; prepare and sign a new ClobAuth explicitly.", 401);
      throw error;
    }
    let reauthenticationRequested = false;
    try {
      const client = await createSecureClient({ credentials, wallet, signer: blockedSigner(signer, (payload) => { reauthenticationRequested = payload.primaryType === "ClobAuth"; }) });
      if (client.account.signerType !== SignerType.OWNER) throw new Error("PS_WALLET_BINDING: SDK session-key wallets require a separate supported signer flow; use the wallet owner.");
      return client;
    } catch (error) {
      if (reauthenticationRequested) throw new ClobRequestError("PS_CLOB_AUTH_REJECTED", "Polymarket requires fresh authentication; prepare and sign a new ClobAuth explicitly.");
      throw error;
    }
  });
}

async function sdkResponse(call: () => Promise<unknown>): Promise<{ status: number; data: unknown | null }> {
  const scope: { writes: Set<string>; mutationStatus?: number; responseStatus?: number } = { writes: new Set() };
  try {
    const data = await sdkHttpScope.run(scope, call);
    if (scope.responseStatus === undefined) throw new Error("PS_PROVIDER_INVALID: SDK response has no observed HTTP status.");
    return { status: scope.responseStatus, data };
  }
  catch (error) {
    if (error instanceof RequestRejectedError) return { status: error.status, data: null };
    if (error instanceof RateLimitError) return { status: 429, data: null };
    if (scope.mutationStatus !== undefined) return { status: scope.mutationStatus, data: null };
    throw error;
  }
}

async function sdkReadOrder(client: ClobCredentials, orderId: string) {
  return sdkResponse(async () => {
    const order = await client.fetchOrder({ orderId });
    return { id: order.id, status: order.status, order_type: order.orderType, original_size: String(order.originalSize),
      size_matched: String(order.sizeMatched), asset_id: order.assetId, side: order.side, associate_trades: order.associateTrades };
  });
}

async function sdkOrderPayload(client: ClobCredentials, order: { assetId: string; side: string; price: string; size: string }) {
  const workflow = await prepareLimitOrder(client, { assetId: order.assetId, side: order.side === "BUY" ? OrderSide.BUY : OrderSide.SELL, price: order.price, size: order.size });
  try {
    const step = await runSdk(() => workflow.next());
    if (step.done) throw new Error("PS_PROVIDER_INVALID: SDK did not request order signing.");
    return wireTypedData(step.value.payload);
  } finally { await workflow.return(undefined!); }
}

function signedSdkOrder(prepared: PreparedOrder, signature: string): SignedOrder {
  const { order, wallet } = prepared;
  return {
    salt: order.salt, timestamp: order.timestamp, tokenId: toTokenId(order.assetId),
    maker: expectEvmAddress(wallet.makerAddress), signer: expectEvmAddress(wallet.orderSignerAddress),
    makerAmount: order.makerAmount, takerAmount: order.takerAmount,
    side: order.side === "BUY" ? OrderSide.BUY : OrderSide.SELL,
    signatureType: wallet.signatureType, metadata: expectHexString(order.metadata), builder: expectHexString(order.builder),
    expiration: 0, orderType: order.orderType === "FAK" ? OrderType.FAK : OrderType.FOK,
    signature: wallet.type === "DEPOSIT_WALLET" ? expectErc1271Signature(signature) : expectEvmSignature(signature),
  };
}

function clobPrivateHttpFailure(status: number): { code: string; message: string } {
  if (status === 401) return {
    code: "PS_CLOB_PRIVATE_AUTH_REJECTED",
    message: "Polymarket rejected L2 order authentication; verify the derived CLOB credentials.",
  };
  if (status === 403) return {
    code: "PS_CLOB_FORBIDDEN",
    message: "Polymarket denied this CLOB request.",
  };
  if (status === 400) return {
    code: "PS_CLOB_REJECTED",
    message: "Polymarket rejected the CLOB request.",
  };
  if (status === 429 || status >= 500) return {
    code: "PS_PROVIDER_UNAVAILABLE",
    message: `Polymarket CLOB request failed with HTTP ${status}.`,
  };
  return {
    code: "PS_CLOB_REQUEST_REJECTED",
    message: `Polymarket rejected the CLOB request with HTTP ${status}.`,
  };
}

async function checkGeoblock(): Promise<boolean> {
  return geoblockSchema.parse(await getJson(GEOBLOCK_API)).blocked;
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
  orderId: string; requestedSize: string; record: unknown; orderType?: "FAK" | "FOK";
}): z.infer<typeof executionResultSchema> | null {
  const parsed = orderReadSchema.safeParse(input.record);
  if (!parsed.success) return null;
  const record = parsed.data;
  if (record.id !== undefined && record.id.toLowerCase() !== input.orderId.toLowerCase()) return null;
  const original = record.original_size ?? input.requestedSize;
  const matched = record.size_matched;
  const status = mapOrderStatus(record.status, matched, original);
  const reportedOrderType = record.order_type?.toUpperCase();
  const orderType = reportedOrderType === "FAK" || reportedOrderType === "FOK" ? reportedOrderType : input.orderType ?? FAK;
  const filledSize = matched === undefined ? null : matched;
  let remainingSize: string | null = null;
  if (matched !== undefined) {
    try {
      const remaining = toUnits(original, 6) - toUnits(matched, 6);
      remainingSize = remaining >= 0n ? formatUnits(remaining, 6) : null;
    } catch { remainingSize = null; }
  }
  return executionResultSchema.parse({
    status, orderId: input.orderId, orderType,
    requestedSize: input.requestedSize, filledSize, remainingSize,
    tradeIds: record.associate_trades ?? [],
    message: status === "FILLED" ? "Order status read-back reports the requested size filled."
      : status === "PARTIALLY_FILLED" ? `Order status read-back reports a partial fill; the ${orderType} remainder does not rest.`
        : status === "OPEN" ? "Order status read-back reports an open order; inspect or cancel it explicitly."
          : `Polymarket order status: ${status}.`,
  });
}

function validatePreparedOrder(prepared: PreparedOrder): void {
  const order = prepared.order;
  if (BigInt(order.salt) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("PS_ORDER_INVALID: Order salt exceeds the exact integer range of the CLOB JSON format.");
  }
  if (!Number.isSafeInteger(Number(order.timestamp)) || Number(order.timestamp) <= 0) {
    throw new Error("PS_ORDER_INVALID: Prepared order timestamp is invalid.");
  }
  const signed = standardOrderPayload(prepared).message;
  const approved = { salt: order.salt, timestamp: order.timestamp, tokenId: order.assetId,
    maker: prepared.wallet.makerAddress, signer: prepared.wallet.orderSignerAddress,
    makerAmount: order.makerAmount, takerAmount: order.takerAmount, side: order.side === "BUY" ? 0 : 1,
    signatureType: prepared.wallet.signatureType, metadata: order.metadata, builder: order.builder };
  if (Object.entries(approved).some(([key, value]) => String(signed[key]).toLowerCase() !== String(value).toLowerCase())) {
    throw new Error("PS_SIGNATURE_INVALID: SDK signing payload does not bind the exact prepared intent.");
  }
}

function assertSignedWireBinding(prepared: PreparedOrder, order: SignedOrder) {
  const signed = standardOrderPayload(prepared).message;
  const wire = {
    salt: order.salt, timestamp: order.timestamp, tokenId: order.tokenId, maker: order.maker, signer: order.signer,
    makerAmount: order.makerAmount, takerAmount: order.takerAmount, side: order.side === OrderSide.BUY ? 0 : 1,
    signatureType: order.signatureType, metadata: order.metadata, builder: order.builder,
  };
  if (Object.entries(wire).some(([key, value]) => String(signed[key]).toLowerCase() !== String(value).toLowerCase())) {
    throw new Error("PS_SIGNATURE_INVALID: SDK wire order differs from the exact approved signed payload.");
  }
  if (order.orderType !== (prepared.order.orderType === "FAK" ? OrderType.FAK : OrderType.FOK)) {
    throw new Error("PS_ORDER_TYPE_MISMATCH: SDK wire order differs from the trusted prepared order type.");
  }
}

function textToolResult(tool: string, structuredContent: unknown) {
  let result = structuredContent;
  if (tool === "search_markets") {
    const output = z.object({ markets: z.array(marketResultSchema), resultCount: z.number().int() }).parse(structuredContent);
    result = {
      resultCount: output.resultCount,
      markets: output.markets.map((market) => ({
        eventTitle: market.eventTitle, marketId: market.marketId, question: market.question,
        conditionId: market.conditionId, version: market.version, negRisk: market.negRisk,
        acceptingOrders: market.acceptingOrders, endDate: market.endDate,
        volume: market.volume, volume24h: market.volume24h, liquidity: market.liquidity,
        outcomes: market.outcomes, yesAssetId: market.yesAssetId, noAssetId: market.noAssetId,
        observedAt: market.observedAt,
      })),
    };
  } else if (tool === "validate_order_signature") {
    const output = z.object({
      localSignerVerified: z.boolean(), expectedSignerAddress: addressSchema,
      recoveredSignerAddress: addressSchema.nullable(), signatureEncoding: z.enum(["EIP-712", "ERC-7739"]),
      signedOrderSignature: z.string().nullable(), contractWalletAcceptance: z.enum(["NOT_APPLICABLE", "DEFERRED_TO_CLOB"]),
    }).parse(structuredContent);
    result = {
      localSignerVerified: output.localSignerVerified,
      expectedSignerAddress: output.expectedSignerAddress,
      recoveredSignerAddress: output.recoveredSignerAddress,
      signatureEncoding: output.signatureEncoding,
      contractWalletAcceptance: output.contractWalletAcceptance,
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ tool, result }) ?? "{}" }],
    structuredContent,
  };
}

function tradeToolResult(value: unknown, tool = "order_result") {
  const result = executionResultSchema.parse(value);
  return textToolResult(tool, result);
}

function decimalUnits(value: string, decimals: number): bigint | null {
  if (!/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

function poissonDistribution(lambda: number, maxGoals: number): number[] {
  const values = [Math.exp(-lambda)];
  for (let goals = 1; goals <= maxGoals; goals += 1) {
    values.push((values[goals - 1] ?? 0) * lambda / goals);
  }
  return values;
}

function estimateSoccerProbabilities(homeLambda: number, awayLambda: number) {
  const maxGoals = Math.max(12, Math.ceil(Math.max(homeLambda, awayLambda) + 10 * Math.sqrt(Math.max(homeLambda, awayLambda)) + 10));
  if (maxGoals > 100) return null;
  const home = poissonDistribution(homeLambda, maxGoals);
  const away = poissonDistribution(awayLambda, maxGoals);
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  for (let homeGoals = 0; homeGoals <= maxGoals; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals <= maxGoals; awayGoals += 1) {
      const probability = (home[homeGoals] ?? 0) * (away[awayGoals] ?? 0);
      if (homeGoals > awayGoals) homeWin += probability;
      else if (homeGoals === awayGoals) draw += probability;
      else awayWin += probability;
    }
  }
  const total = homeWin + draw + awayWin;
  if (!(total > 0) || !Number.isFinite(total)) return null;
  return { homeWin: homeWin / total, draw: draw / total, awayWin: awayWin / total, tail: Math.max(0, 1 - total) };
}

function formVenueGoals(results: z.infer<typeof soccerObservedResultSchema>[], venue: "HOME" | "AWAY") {
  const selected = results.filter((result) => result.venue === venue).flatMap((result) => {
    const score = /^(\d+)-(\d+)$/.exec(result.score);
    return score ? [{ scored: Number(score[1]), conceded: Number(score[2]) }] : [];
  });
  if (selected.length === 0) return null;
  return {
    played: selected.length,
    goalsForAverage: selected.reduce((total, result) => total + result.scored, 0) / selected.length,
    goalsAgainstAverage: selected.reduce((total, result) => total + result.conceded, 0) / selected.length,
  };
}

function analyzeSoccerEdge(input: {
  fixture: z.infer<typeof soccerFixtureSchema> | z.infer<typeof providerQualifiedFixtureSchema>;
  quote: z.infer<typeof quoteResultSchema>;
  outcome: "HOME_WIN" | "DRAW" | "AWAY_WIN";
  marketResolutionType: "REGULATION_1X2" | "OTHER" | "UNKNOWN";
  marketResolutionRules: string;
  identityEvidence?: z.infer<typeof identityEvidenceSchema>[];
  marketMapping?: z.infer<typeof marketMappingSchema>;
}) {
  const analysisNowMs = Date.now();
  const now = new Date(analysisNowMs).toISOString();
  const quoteAgeMsAtAnalysis = bookAgeMs(input.quote.bookTimestamp, analysisNowMs);
  const quoteFreshness = quoteAgeMsAtAnalysis === null ? "UNKNOWN" as const
    : quoteAgeMsAtAnalysis <= input.quote.staleAfterSeconds * 1000 ? "FRESH" as const : "STALE" as const;
  const providerFixture = "provider" in input.fixture ? input.fixture : null;
  const footballDataFixture = "fixtureId" in input.fixture ? input.fixture : null;
  const fallbackFixture = providerFixture !== null;
  const enrichment = footballDataFixture?.apiFootball ?? null;
  const home = providerFixture?.homeStats ?? enrichment?.homeStats ?? null;
  const away = providerFixture?.awayStats ?? enrichment?.awayStats ?? null;
  const homeRecentVenue = footballDataFixture ? formVenueGoals(footballDataFixture.homeRecentResults, "HOME") : null;
  const awayRecentVenue = footballDataFixture ? formVenueGoals(footballDataFixture.awayRecentResults, "AWAY") : null;
  const apiSources = providerFixture ? providerFixture.sources : enrichment?.sources ?? [];
  const hasApiFootballSources = apiSources.filter((source) => source.purpose === "TEAM_STATISTICS" && source.availability === "AVAILABLE").length === 2;
  const hasFormSources = footballDataFixture?.formSources?.length === 2;
  const normalizedFixtureIdentity = {
    competition: normalizedProviderName(input.fixture.competition),
    homeTeam: normalizedTeamName(input.fixture.homeTeam),
    awayTeam: normalizedTeamName(input.fixture.awayTeam),
    kickoffUtc: Date.parse(input.fixture.kickoffUtc),
  };
  const matchingIdentityEvidence = (input.identityEvidence ?? []).filter((evidence) => evidence.provider !== "API-Football"
    && evidence.verificationStatus === "VERIFIED"
    && normalizedProviderName(evidence.competition) === normalizedFixtureIdentity.competition
    && normalizedTeamName(evidence.homeTeam) === normalizedFixtureIdentity.homeTeam
    && normalizedTeamName(evidence.awayTeam) === normalizedFixtureIdentity.awayTeam
    && Date.parse(evidence.kickoffUtc) === normalizedFixtureIdentity.kickoffUtc);
  const apiIdentityVerified = !fallbackFixture || matchingIdentityEvidence.length > 0;
  const apiStatisticsUsable = (fallbackFixture || enrichment?.availability === "AVAILABLE") && apiIdentityVerified && home !== null && away !== null
    && hasApiFootballSources && home.playedAtHome > 0 && away.playedAway > 0 && home.goalsForAverage !== null && home.goalsAgainstAverage !== null
    && away.goalsForAverage !== null && away.goalsAgainstAverage !== null;
  const formStatisticsUsable = hasFormSources && homeRecentVenue !== null && awayRecentVenue !== null;
  const statisticsProvider = apiStatisticsUsable ? "API-Football" as const : formStatisticsUsable ? "football-data.org" as const : null;
  const homeGoalsFor = apiStatisticsUsable ? home.goalsForAverage : homeRecentVenue?.goalsForAverage ?? null;
  const homeGoalsAgainst = apiStatisticsUsable ? home.goalsAgainstAverage : homeRecentVenue?.goalsAgainstAverage ?? null;
  const awayGoalsFor = apiStatisticsUsable ? away.goalsForAverage : awayRecentVenue?.goalsForAverage ?? null;
  const awayGoalsAgainst = apiStatisticsUsable ? away.goalsAgainstAverage : awayRecentVenue?.goalsAgainstAverage ?? null;
  const homeSample = apiStatisticsUsable ? home.playedAtHome : homeRecentVenue?.played ?? null;
  const awaySample = apiStatisticsUsable ? away.playedAway : awayRecentVenue?.played ?? null;
  const inputs = {
    statisticsProvider,
    homeGoalsForAverageAtHome: homeGoalsFor,
    homeGoalsAgainstAverageAtHome: homeGoalsAgainst,
    awayGoalsForAverageAway: awayGoalsFor,
    awayGoalsAgainstAverageAway: awayGoalsAgainst,
    homeMatchesAtHome: homeSample,
    awayMatchesAway: awaySample,
    cutoffDate: statisticsProvider === "API-Football" ? addDays(input.fixture.kickoffUtc.slice(0, 10), -1) : statisticsProvider === "football-data.org" ? input.fixture.kickoffUtc : null,
  };
  const sources: Array<{ provider: "API-Football" | "football-data.org"; url: string; observedAt: string }> = [];
  if (statisticsProvider === "API-Football") {
    sources.push(...(apiSources.filter((source) => source.purpose === "TEAM_STATISTICS" && source.availability === "AVAILABLE")
      .map((source) => ({ provider: "API-Football" as const, url: source.url, observedAt: source.observedAt })) ?? []));
  }
  if (footballDataFixture && statisticsProvider === "football-data.org") {
    sources.push(...(footballDataFixture.formSources ?? []));
  }
  let probabilities: ReturnType<typeof estimateSoccerProbabilities> = null;
  let homeLambda: number | null = null;
  let awayLambda: number | null = null;
  let probabilityReason: string | null = null;
  if (statisticsProvider === null || homeGoalsFor === null || homeGoalsAgainst === null || awayGoalsFor === null || awayGoalsAgainst === null) {
    probabilityReason = fallbackFixture && !apiIdentityVerified
      ? "Independent evidence verifying the API-Football fixture identity is required before modeling this target match."
      : enrichment?.reason ?? (fallbackFixture ? "API-Football venue statistics are missing or incomplete for the exact fixture." : "Venue-specific goal averages and at least one completed match for both venue samples are required for this model.");
  } else {
    homeLambda = (homeGoalsFor + awayGoalsAgainst) / 2;
    awayLambda = (awayGoalsFor + homeGoalsAgainst) / 2;
    probabilities = estimateSoccerProbabilities(homeLambda, awayLambda);
    if (!probabilities) probabilityReason = "The goal-rate inputs are outside the supported numerical range for this calculation.";
  }
  const available = probabilities !== null;
  const probability = probabilities === null ? null : input.outcome === "HOME_WIN" ? probabilities.homeWin : input.outcome === "DRAW" ? probabilities.draw : probabilities.awayWin;
  const uncertainty = [];
  if (homeSample !== null && homeSample < 5) uncertainty.push(`Home venue sample is small (${homeSample} matches).`);
  if (awaySample !== null && awaySample < 5) uncertainty.push(`Away venue sample is small (${awaySample} matches).`);
  uncertainty.push("The independent Poisson model assumes independent team goal counts; it is not calibrated by this implementation.");
  if (statisticsProvider === "API-Football") uncertainty.push("API-Football season-to-date venue averages and football-data.org recent form use different sample windows; differences between them are not directly comparable.");
  if (fallbackFixture) uncertainty.push("The fallback fixture was returned by API-Football only; independent identity evidence was supplied separately and was not used as model statistics.");
  const model = {
    name: "Independent Poisson Goals Model" as const, version: "1.0.0" as const,
    expectedHomeGoals: homeLambda, expectedAwayGoals: awayLambda,
    homeWin: probabilities?.homeWin ?? null, draw: probabilities?.draw ?? null, awayWin: probabilities?.awayWin ?? null,
    truncatedTailProbability: probabilities?.tail ?? null, normalized: probabilities !== null,
    inputs, sources, assumptions: ["Home expected goals are the mean of home-team home goals-for and away-team away goals-against averages.",
      "Away expected goals are the mean of away-team away goals-for and home-team home goals-against averages.",
      ...(statisticsProvider === "API-Football" ? ["API-Football team statistics are requested through the UTC calendar day before kickoff to avoid same-day look-ahead."]
        : statisticsProvider === "football-data.org" ? ["Recent completed form uses only matching-venue results returned before target kickoff."] : [])],
    uncertainty, calculatedAt: now,
  };
  let edgeStatus: "AVAILABLE" | "UNAVAILABLE" | "UNSUPPORTED_MARKET" = "UNAVAILABLE";
  let edgeReason: string | null = null;
  let fillableShares: string | null = null;
  let unfilledShares: string | null = null;
  let weightedPrice: string | null = null;
  let estimatedFees: string | null = null;
  let effectiveCost: string | null = null;
  let grossDifference: string | null = null;
  let netEdge: string | null = null;
  let expectedValue: string | null = null;
  const mapping = input.marketMapping;
  const marketMappingMatches = !fallbackFixture || (mapping !== undefined
    && mapping.provider === "Polymarket Gamma"
    && mapping.marketId === input.quote.marketId && mapping.question === input.quote.question && mapping.outcome === input.quote.outcome
    && mapping.outcomeMapping === input.outcome && mapping.resolutionType === input.marketResolutionType
    && mapping.resolutionRules === input.marketResolutionRules
    && normalizedProviderName(mapping.competition) === normalizedFixtureIdentity.competition
    && normalizedTeamName(mapping.homeTeam) === normalizedFixtureIdentity.homeTeam
    && normalizedTeamName(mapping.awayTeam) === normalizedFixtureIdentity.awayTeam
    && Date.parse(mapping.kickoffUtc) === normalizedFixtureIdentity.kickoffUtc);
  if (input.marketResolutionType !== "REGULATION_1X2") {
    edgeStatus = "UNSUPPORTED_MARKET";
    edgeReason = "Only a market whose published resolution rules exactly match 90-minute Home/Draw/Away outcomes is supported.";
  } else if (!available || probability === null) {
    edgeReason = "No edge was calculated because the independent outcome probability is unavailable.";
  } else if (!marketMappingMatches) {
    edgeReason = "No market-specific edge was calculated because the supplied Polymarket market, outcome mapping, and fixture identity do not all match.";
  } else if (input.quote.side !== "BUY") {
    edgeReason = "SELL edge is not calculated without the existing position's cost basis and sale-proceeds treatment.";
  } else if (input.quote.availability !== "AVAILABLE" || input.quote.requestedSize === null || input.quote.fillableSize === null
    || input.quote.averagePrice === null || input.quote.grossAmountPusd === null || input.quote.estimatedFeePusd === null) {
    edgeReason = "The CLOB quote does not contain executable BUY depth and fee data for a requested size.";
  } else {
    const shares = decimalUnits(input.quote.fillableSize, 6);
    const gross = decimalUnits(input.quote.grossAmountPusd, 12);
    const fees6 = decimalUnits(input.quote.estimatedFeePusd, 6);
    const vwap6 = decimalUnits(input.quote.averagePrice, 6);
    const requested6 = decimalUnits(input.quote.requestedSize, 6);
    const probability12 = decimalUnits(probability.toFixed(12), 12);
    if (shares === null || shares <= 0n || gross === null || fees6 === null || vwap6 === null || requested6 === null || probability12 === null) {
      edgeReason = "The supplied quote contains invalid or unsupported decimal precision.";
    } else {
      const fees12 = fees6 * 1_000_000n;
      const costPerShare12 = ceilDiv((gross + fees12) * 1_000_000n, shares);
      const vwap12 = vwap6 * 1_000_000n;
      const edge12 = probability12 - costPerShare12;
      const unfilled = input.quote.unfilledSize === null ? 0n : decimalUnits(input.quote.unfilledSize, 6);
      edgeStatus = "AVAILABLE";
      edgeReason = null;
      fillableShares = formatUnits(shares, 6);
      unfilledShares = unfilled === null ? input.quote.unfilledSize : formatUnits(unfilled, 6);
      weightedPrice = formatUnits(vwap6, 6);
      estimatedFees = formatUnits(fees6, 6);
      effectiveCost = formatUnits(costPerShare12, 12);
      grossDifference = formatUnits(probability12 - vwap12, 12);
      netEdge = formatUnits(edge12, 12);
      expectedValue = formatUnits(shares * edge12 / 1_000_000_000_000n, 6);
      if (requested6 > shares) uncertainty.push("Visible CLOB depth supports only a partial fill of the requested size; expected value uses the fillable shares only.");
    }
  }
  const calculationAssumptions = [
    "Polymarket CLOB BUY ask levels, requested size, estimated gross cost, and fees come from the supplied get_quote result; midpoint and Gamma indicative prices are not used.",
    "The 30-second quote freshness threshold is a PolyScope analysis indicator, not a Polymarket order-expiration rule.",
    "The estimate covers only visible fillable shares; FAK may partially fill and discards the unfilled remainder.",
    "Net edge per share equals modeled probability minus (estimated gross fill cost plus fees) divided by fillable shares.",
    "Expected value is fillable shares multiplied by estimated net edge per share; it is not guaranteed profitability.",
    `Market resolution rules supplied for the mapping: ${input.marketResolutionRules}`,
  ];
  if (quoteFreshness === "STALE") calculationAssumptions.push(`This is a historical edge estimate based on the book observed at ${input.quote.observedAt}; its ${quoteAgeMsAtAnalysis} ms age at analysis means it must not be treated as current executable market evidence.`);
  if (quoteFreshness === "UNKNOWN") calculationAssumptions.push(`Quote freshness is unknown at analysis time; the quote observed at ${input.quote.observedAt} cannot be treated as current executable market evidence.`);
  if (fallbackFixture) calculationAssumptions.push("Identity and market evidence are host-agent attestations. PolyScope checks supplied fields for consistency but does not fetch source URLs or independently verify claims.");
  return soccerEdgeOutputSchema.parse({
    probabilityStatus: available ? "AVAILABLE" : "UNAVAILABLE", probabilityReason,
    model, edgeStatus, edgeReason,
    marketId: input.quote.marketId, assetId: input.quote.assetId, marketOutcome: input.quote.outcome, outcome: input.outcome,
    requestedShares: input.quote.requestedSize, fillableShares, unfilledShares,
    bestBid: input.quote.bestBid, bestAsk: input.quote.bestAsk, spread: input.quote.spread, depthWeightedExecutionPrice: weightedPrice,
    estimatedFeesPusd: estimatedFees, effectiveBuyCostPerShare: effectiveCost, grossProbabilityPriceDifference: grossDifference,
    netEdgePerShare: netEdge, estimatedExpectedValuePusd: expectedValue, quoteObservedAt: input.quote.observedAt,
    quoteBookTimestamp: input.quote.bookTimestamp, quoteFreshness, quoteFreshnessAtCapture: input.quote.freshness,
    quoteAgeMsAtAnalysis, quoteStaleAfterSeconds: input.quote.staleAfterSeconds, calculationAssumptions,
    ...(fallbackFixture ? {
      identityEvidence: matchingIdentityEvidence.map((evidence) => ({ ...evidence, attestationAuthority: "HOST_AGENT" as const })),
      ...(mapping ? { marketMapping: { ...mapping, attestationAuthority: "HOST_AGENT" as const } } : {}),
      evidenceAssessment: {
        claimAuthority: "HOST_AGENT" as const,
        sourceVerification: "NOT_PERFORMED_BY_POLYSCOPE" as const,
        identityClaimMatchesFixture: matchingIdentityEvidence.length > 0,
        marketClaimMatchesSuppliedQuoteAndFixture: mapping !== undefined && marketMappingMatches,
      },
    } : {}),
  });
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
      return textToolResult("search_markets", { markets, resultCount: markets.length });
    },
  );

  server.registerTool(
    "get_quote",
    {
      title: "Read a Polymarket order book quote",
      description: "Reads the public CLOB book and current fee rate for one market outcome and estimates visible BUY/SELL fill, average price, gross amount, and fee. No order is created. The 30-second freshness threshold is a PolyScope indicator, not an order-expiration rule; analysis recalculates freshness from the book timestamp.",
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
      const feeInfo = await getMarketFeeInfo(market.conditionId);
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
      return textToolResult("get_quote", structuredContent);
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
      return textToolResult("get_soccer_news", structuredContent);
    },
  );

  server.registerTool(
    "research_soccer",
    {
      title: "Research supported soccer fixtures",
      description: "Reads football-data.org fixtures, results, and available recent form for PL, PD, SA, or CL. On provider failures or unusable responses, it makes one date-scoped API-Football fixture fallback request; a valid empty football-data.org response does not trigger fallback. API-Football-only fixtures use provider-qualified IDs and are not cross-provider verified. For exact fallback matching, provide fixtureIdentity with homeTeam, awayTeam, and kickoffUtc; a football-data.org fixtureId is never reused as an API-Football ID. Set includeApiFootball=true on an exact football-data.org fixture to keep the existing optional enrichment. The legacy provider field identifies the primary provider; availability is aggregate, and resultProvider identifies the source of returned fixtures (football-data.org or API-Football). Fallback coverage reports requested and queried dates. These tools provide API evidence, not exhaustive research. When statistics, injuries, lineups or other relevant information are missing, continue with the host's web search/browser tools before writing the final analysis. If either structured provider fails or leaves material gaps, continue with host-native search/browser tools where available; do not claim browser work unless performed.",
      inputSchema: z.object({
        league: z.enum(["PL", "PD", "SA", "CL"]),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        days: z.number().int().min(0).max(14).default(0),
        fixtureId: z.string().regex(/^[0-9]{1,20}$/).optional(),
        fixtureIdentity: fixtureIdentitySchema.optional(),
        limit: z.number().int().min(1).max(20).default(10),
        includeApiFootball: z.boolean().default(false),
      }).strict(),
      outputSchema: soccerResearchOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ league, date, days, fixtureId, fixtureIdentity, limit, includeApiFootball }) => {
      if (date !== undefined && !validDate(date)) throw new Error("PS_DATE_INVALID: Use a valid UTC calendar date in YYYY-MM-DD format.");
      const structuredContent = await getSoccerResearch({ league, date, days, fixtureId, fixtureIdentity, limit, includeApiFootball });
      return textToolResult("research_soccer", structuredContent);
    },
  );

  server.registerTool(
    "analyze_soccer_edge",
    {
      title: "Estimate soccer probabilities and Polymarket net edge",
      description: "Deterministically estimates regulation-time Home/Draw/Away probabilities from API-Football venue averages or football-data.org pre-kickoff same-venue form. It recalculates quote freshness from the original book timestamp at analysis time; the 30-second label is informational, and stale quote results are historical rather than current executable evidence. For API-Football-only fallback fixtures, identityEvidence and marketMapping are host-agent attestations: their source URLs are not fetched or independently verified by PolyScope. PolyScope checks supplied identity fields against the fixture and supplied market fields against the quote, fixture, and rules; evidenceAssessment reports these local checks separately from external source verification. Without a host-attested VERIFIED identity claim, probabilities are UNAVAILABLE; without a consistent market mapping and exact 90-minute resolution declaration, market-specific edge is unavailable. Browser-researched statistics are not model inputs. This read-only analysis does not fetch providers, create orders, impose a trading gate, or authorize a trade.",
      inputSchema: z.object({
        fixture: z.union([soccerFixtureSchema, providerQualifiedFixtureSchema]), quote: quoteResultSchema,
        outcome: z.enum(["HOME_WIN", "DRAW", "AWAY_WIN"]),
        marketResolutionType: z.enum(["REGULATION_1X2", "OTHER", "UNKNOWN"]),
        marketResolutionRules: z.string().min(1).max(4_000),
        identityEvidence: z.array(identityEvidenceSchema).optional(), marketMapping: marketMappingSchema.optional(),
      }).strict(),
      outputSchema: soccerEdgeOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const result = analyzeSoccerEdge(input);
      return textToolResult("analyze_soccer_edge", result);
    },
  );

  server.registerTool(
    "prepare_clob_auth",
    {
      title: "Prepare Polymarket CLOB authentication signature",
      description: "Uses the official SDK authentication workflow and its current timestamp to prepare the Polygon ClobAuth EIP-712 payload for the existing owner EOA signer. The PayBox agent must call request_wallet_sign with the matching wallet credential, poll get_request, then reuse that signed ClobAuth across related authenticated calls while Polymarket accepts it. No signature or credentials are sent by this tool.",
      inputSchema: z.object({ signerAddress: addressSchema, nonce: z.string().regex(/^(0|[1-9][0-9]{0,77})$/).default("0") }).strict(),
      outputSchema: typedOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ signerAddress, nonce }) => {
      if (BigInt(nonce) >= 1n << 256n) throw new Error("PS_AUTH_NONCE_INVALID: Nonce exceeds uint256.");
      const signer = address(signerAddress);
      const typedData = wireTypedData(await clobAuthTypedData(signer, undefined, nonce));
      const timestamp = z.string().parse(typedData.message.timestamp);
      const intent = { op: "typedData" as const, typedData };
      return textToolResult("prepare_clob_auth", {
        signingAddress: signer,
        timestamp,
        nonce,
        typedData,
        requestWalletSignIntent: intent,
      });
    },
  );

  server.registerTool(
    "prepare_order_signing",
    {
      title: "Prepare a bounded Polymarket BUY or SELL signature",
      description: "Accepts reusable signed ClobAuth and asks the official SDK to prepare an unsigned FAK or FOK order for the selected market outcome, side, price, and size. The returned size reflects SDK rounding. orderType defaults to FAK. Polymarket CLOB determines whether a FOK order fills in full. BUY priceLimit is the maximum; SELL priceLimit is the minimum. PayBox handles human approval and wallet signing for the Polymarket order.",
      inputSchema: z.object({
        marketId: z.string().regex(/^[0-9]{1,32}$/), assetId: decimalIdSchema,
        makerAddress: addressSchema, signingAddress: addressSchema, clobAuth: clobAuthSchema,
        walletType: walletTypeSchema.optional(), side: sideSchema,
        orderType: orderTypeSchema.default(FAK),
        priceLimit: z.string().max(32), size: z.string().max(32),
      }).strict(),
      outputSchema: z.discriminatedUnion("status", [
        z.object({
          status: z.literal("PREPARED"),
          preparedOrder: preparedOrderSchema,
          requestWalletSignIntent: requestWalletSignIntentSchema,
          submitsOrder: z.literal(false),
        }).strict(),
        z.object({
          status: z.literal("REJECTED"), errorCode: preparationErrorCodeSchema, reason: z.string(),
          submitsOrder: z.literal(false),
        }).strict(),
      ]),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ marketId, assetId, makerAddress, signingAddress, clobAuth, side, orderType, priceLimit, size }) => {
      try {
        const marketUrl = `${GAMMA_API}/markets/${encodeURIComponent(marketId)}`;
        const rawMarket = await getJson(marketUrl);
        const parsedMarket = gammaMarketSchema.safeParse(rawMarket);
        if (!parsedMarket.success) throw new Error("PS_PROVIDER_INVALID: Polymarket market does not match the required schema.");
        const market = parsedMarket.data;
        if (String(market.id) !== marketId) throw new Error("PS_MARKET_IDENTITY: Provider returned a different market ID.");
        if (!market.conditionId) throw new Error("PS_MARKET_UNSUPPORTED: The selected market is missing its condition ID.");
        const mappedOutcomes = marketOutcomeAssets(market);
        const selectedOutcome = mappedOutcomes?.find((outcome) => outcome.assetId === assetId);
        if (!selectedOutcome) throw new Error("PS_MARKET_IDENTITY: The asset ID is not mapped to an outcome in this market.");

        const maker = address(makerAddress);
        const signing = address(signingAddress);
        const client = await deriveClobCredentials(clobAuth, signing, maker);
        const walletType = ["EOA", "PROXY", "SAFE", "DEPOSIT_WALLET"][client.account.walletType];
        if (!walletType) throw new Error("PS_WALLET_BINDING: SDK returned an unsupported account wallet type.");
        const typedData = await sdkOrderPayload(client, { assetId, side, price: priceLimit, size });
        const sdkMessage = typedData.primaryType === "TypedDataSign" ? z.record(z.string(), z.unknown()).parse(typedData.message.contents) : typedData.message;
        const sdkFields = z.object({ salt: z.union([z.number(), z.string()]).transform(String), timestamp: z.union([z.number(), z.string()]).transform(String), signer: addressSchema,
          tokenId: z.union([z.number(), z.string()]).transform(String), maker: addressSchema,
          signatureType: z.number().int().min(0).max(3), makerAmount: z.union([z.number(), z.string()]).transform(String),
          takerAmount: z.union([z.number(), z.string()]).transform(String), metadata: z.string(), builder: z.string() }).parse(sdkMessage);
        const orderSigner = sdkFields.signer;
        const salt = sdkFields.salt;
        const timestamp = sdkFields.timestamp;
        const makerAmount = sdkFields.makerAmount;
        const takerAmount = sdkFields.takerAmount;
        const preparedBase = preparedOrderBaseSchema.parse({
          market: {
            id: marketId, conditionId: market.conditionId, outcome: selectedOutcome.name,
          },
          wallet: {
            type: walletType, makerAddress: maker, signingAddress: signing,
            orderSignerAddress: orderSigner, signatureType: sdkFields.signatureType,
          },
          order: {
            salt, timestamp, assetId: sdkFields.tokenId, side, price: priceLimit,
            size: formatUnits(BigInt(side === "BUY" ? takerAmount : makerAmount), 6), orderType,
            makerAmount, takerAmount, metadata: sdkFields.metadata, builder: sdkFields.builder,
          },
        });
        const preparedOrder = preparedOrderSchema.parse({ ...preparedBase, typedData });
        const intent = { op: "typedData" as const, typedData };
        return textToolResult("prepare_order_signing", {
          status: "PREPARED" as const, preparedOrder, requestWalletSignIntent: intent,
          submitsOrder: false as const,
        });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        const code = preparationErrorCodeSchema.safeParse(error.message.split(":", 1)[0]);
        if (!code.success) {
          if (error.name === "UnexpectedResponseError" || error.name === "TransportError" || error.name === "RequestRejectedError" || error.name === "UserInputError") {
            const failure = clobRequestFailure(error, "PS_PROVIDER_INVALID", "Official SDK preparation could not complete.");
            return textToolResult("prepare_order_signing", { status: "REJECTED", errorCode: preparationErrorCodeSchema.safeParse(failure.code).success ? failure.code : "PS_PROVIDER_INVALID",
              reason: "Official SDK preparation failed; check authentication, wallet identity, and provider availability.", submitsOrder: false });
          }
          throw error;
        }
        const reason = error.message.slice(code.data.length + 1).trim();
        return textToolResult("prepare_order_signing", {
          status: "REJECTED" as const, errorCode: code.data, reason,
          submitsOrder: false as const,
        });
      }
    },
  );

  server.registerTool(
    "validate_clob_auth_signature",
    {
      title: "Validate a PayBox ClobAuth signature",
      description: "Recovers the signer from the exact ClobAuth payload and checks it against the expected existing PayBox owner EOA. This cryptographic check does not establish timestamp freshness or provider acceptance, and does not derive or return CLOB credentials.",
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
          ...await clobAuthTypedData(expected, timestamp, nonce),
          signature: signatureHex(signature),
        });
      } catch {
        recovered = null;
      }
      const valid = recovered?.toLowerCase() === expected.toLowerCase();
      return textToolResult("validate_clob_auth_signature", { valid, expectedSignerAddress: expected, recoveredSignerAddress: recovered });
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
      return textToolResult("validate_order_signature", {
        localSignerVerified: valid,
        expectedSignerAddress: expected,
        recoveredSignerAddress: validation.recovered,
        signatureEncoding: validation.encoding,
        signedOrderSignature: validation.signedSignature,
        contractWalletAcceptance: validation.contractWalletAcceptance,
      });
    },
  );

  const submitOrderHandler = async (args: {
    preparedOrder: PreparedOrder; orderSignature: string; clobAuth: z.infer<typeof clobAuthSchema>;
    orderType: "FAK" | "FOK"; resultTool: "submit_order" | "submit_fak_order";
  }) => {
      const { preparedOrder: inputOrder, orderSignature, clobAuth, orderType, resultTool } = args;
      const orderResult = (value: unknown) => tradeToolResult(value, resultTool);
      const prepared = preparedOrderSchema.parse(inputOrder);
      validatePreparedOrder(prepared);
      if (prepared.order.orderType !== orderType) return orderResult({
        status: "REJECTED", orderId: null, orderType, requestedSize: prepared.order.size,
        filledSize: null, remainingSize: prepared.order.size, tradeIds: [],
        message: `The submitted ${orderType} does not match the prepared ${prepared.order.orderType}; no order was sent.`,
        errorCode: "PS_ORDER_TYPE_MISMATCH",
      });
      const orderValidation = await validateWalletSignature(prepared, signatureHex(orderSignature));
      if (!orderValidation.valid || orderValidation.signedSignature === null) return orderResult({
        status: "REJECTED", orderId: null, orderType, requestedSize: prepared.order.size,
        filledSize: null, remainingSize: prepared.order.size, tradeIds: [],
        message: "The order signature does not recover to the approved PayBox signer; no order was sent.",
        errorCode: "PS_SIGNATURE_INVALID",
      });

      const signedOrderSignature = orderValidation.signedSignature;
      let credentials: ClobCredentials;
      try {
        const [derivedCredentials, geoblocked] = await Promise.all([
          deriveClobCredentials(clobAuth, prepared.wallet.signingAddress, prepared.wallet.makerAddress),
          checkGeoblock(),
        ]);
        credentials = derivedCredentials;
        if (geoblocked) {
          return orderResult({
            status: "REJECTED", orderId: null, orderType, requestedSize: prepared.order.size,
            filledSize: null, remainingSize: prepared.order.size, tradeIds: [],
            message: "Polymarket geoblock reports this request as blocked; no order was sent.",
            errorCode: "PS_GEOBLOCKED",
          });
        }
      } catch (error) {
        const failure = clobRequestFailure(error, "PS_PREFLIGHT_FAILED", "Polymarket authentication or geoblock check could not be completed; no order was sent.");
        return orderResult({
          status: "FAILED", orderId: null, orderType, requestedSize: prepared.order.size,
          filledSize: null, remainingSize: prepared.order.size, tradeIds: [], message: failure.message,
          errorCode: failure.code, ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
        });
      }

      const orderHash = hashTypedData(viemPayload(standardOrderPayload(prepared)));
      const reconcileSubmission = async (httpStatus?: number, orderId: string = orderHash, tradeIds: string[] = []) => {
        const reconciled = await sdkReadOrder(credentials, orderHash).catch(() => null);
        const known = reconciled?.status === 200 && reconciled.data !== null
          ? orderStatusResult({ orderId: orderHash, requestedSize: prepared.order.size, record: reconciled.data, orderType }) : null;
        if (known && known.status !== "UNKNOWN") return orderResult({ ...known, httpStatus: httpStatus ?? reconciled?.status });
        return orderResult({
          status: "UNKNOWN", orderId, orderType, requestedSize: prepared.order.size,
          filledSize: null, remainingSize: null, tradeIds,
          message: "Polymarket did not authoritatively confirm the order outcome. Do not resubmit; reconcile the order before taking further action.",
          errorCode: "PS_SUBMISSION_UNKNOWN",
          ...((httpStatus ?? reconciled?.status) === undefined ? {} : { httpStatus: httpStatus ?? reconciled?.status }),
        });
      };
      const sdkOrder = signedSdkOrder(prepared, signedOrderSignature);
      try { assertSignedWireBinding(prepared, sdkOrder); }
      catch {
        return orderResult({
          status: "REJECTED", orderId: null, orderType, requestedSize: prepared.order.size,
          filledSize: null, remainingSize: prepared.order.size, tradeIds: [],
          message: "The reconstructed SDK order differs from the exact PayBox-approved payload; no order was sent.",
          errorCode: "PS_SIGNATURE_INVALID",
        });
      }
      let posted: { status: number; data: unknown | null };
      try {
        posted = await sdkResponse(async () => {
          const result = await credentials.postOrder(sdkOrder);
          return result.ok ? { success: true, orderID: result.orderId, tradeIDs: result.tradeIds } : { success: false };
        });
      } catch {
        return reconcileSubmission();
      }
      const response = posted.data === null ? null : clobOrderResponseSchema.safeParse(posted.data);
      if (posted.status >= 400 && posted.status < 500 && posted.status !== 408 && posted.status !== 429) {
        const failure = clobPrivateHttpFailure(posted.status);
        return orderResult({
          status: "REJECTED", orderId: null, orderType, requestedSize: prepared.order.size,
          filledSize: null, remainingSize: prepared.order.size, tradeIds: [],
          message: failure.message, errorCode: failure.code, httpStatus: posted.status,
        });
      }
      if (posted.status === 408 || posted.status === 429 || posted.status >= 500) return reconcileSubmission(posted.status);
      if (response?.success && response.data.success === false) return orderResult({
        status: "REJECTED", orderId: null, orderType, requestedSize: prepared.order.size,
        filledSize: null, remainingSize: prepared.order.size, tradeIds: [],
        message: `Polymarket rejected the ${orderType} order before accepting it.`,
        errorCode: "PS_CLOB_REJECTED", httpStatus: posted.status,
      });
      const responseOrderId = response?.success ? response.data.orderID : undefined;
      const orderId = responseOrderId !== undefined && /^0x[0-9a-fA-F]{64}$/.test(responseOrderId) ? responseOrderId : undefined;
      if (posted.status < 200 || posted.status >= 300 || !response?.success || response.data.success !== true || !orderId) {
        return reconcileSubmission(posted.status, orderId ?? orderHash, response?.success ? response.data.tradeIDs ?? [] : []);
      }
      return orderResult({
        status: "SUBMITTED", orderId, orderType, requestedSize: prepared.order.size,
        filledSize: null, remainingSize: null, tradeIds: response.data.tradeIDs ?? [],
        message: `Polymarket accepted the ${orderType} order. Fill state is not confirmed; call get_order_status for authenticated read-back.`,
        errorCode: null,
      });
  };

  server.registerTool(
    "submit_order",
    {
      title: "Submit a PayBox-approved Polymarket FAK or FOK order",
      description: "Makes one signed FAK or FOK POST attempt after checking the exact PayBox-approved order payload, prepared order type, and official geoblock response. Polymarket CLOB determines whether FOK fills in full. FAK may partially fill. Ambiguous POST results get at most one order-hash read-back and are never automatically resubmitted.",
      inputSchema: z.object({
        preparedOrder: preparedOrderSchema, orderSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
        clobAuth: clobAuthSchema, orderType: orderTypeSchema,
      }).strict(),
      outputSchema: executionResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => submitOrderHandler({ ...args, resultTool: "submit_order" }),
  );

  server.registerTool(
    "submit_fak_order",
    {
      title: "Submit a PayBox-approved Polymarket FAK order",
      description: "Backward-compatible FAK submission wrapper. Makes one signed FAK POST attempt after checking the PayBox-approved payload, prepared FAK type, and official geoblock response. FAK may partially fill. Ambiguous POST results get at most one order-hash read-back and are never automatically resubmitted.",
      inputSchema: z.object({
        preparedOrder: preparedOrderSchema, orderSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/), clobAuth: clobAuthSchema,
      }).strict(),
      outputSchema: executionResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => submitOrderHandler({ ...args, orderType: FAK, resultTool: "submit_fak_order" }),
  );

  server.registerTool(
    "get_order_status",
    {
      title: "Read Polymarket order status and fills",
      description: "Reads one authenticated order record and reports its matched size and trade IDs. No order is placed or retried.",
      inputSchema: z.object({ orderId: z.string().regex(/^0x[0-9a-fA-F]{64}$/), requestedSize: z.string().max(32), signerAddress: addressSchema, clobAuth: clobAuthSchema, orderType: orderTypeSchema.default(FAK) }).strict(),
      outputSchema: executionResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ orderId, requestedSize, signerAddress, clobAuth, orderType }) => {
      let credentials: ClobCredentials;
      try { credentials = await deriveClobCredentials(clobAuth, signerAddress); }
      catch (error) {
        const failure = clobRequestFailure(error, "PS_CLOB_AUTH_FAILED", "Polymarket CLOB credentials could not be derived.");
        return tradeToolResult({
          status: "FAILED", orderId, orderType, requestedSize, filledSize: null, remainingSize: null, tradeIds: [],
          message: failure.message, errorCode: failure.code,
          ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
        }, "get_order_status");
      }
      let result: { status: number; data: unknown | null };
      try {
        result = await sdkReadOrder(credentials, orderId);
      } catch (error) {
        const failure = clobRequestFailure(error, "PS_PROVIDER_UNAVAILABLE", "Polymarket order status could not be read.");
        return tradeToolResult({
          status: "UNKNOWN", orderId, orderType, requestedSize, filledSize: null, remainingSize: null, tradeIds: [],
          message: failure.message, errorCode: failure.code,
          ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
        }, "get_order_status");
      }
      if (result.status === 401) return tradeToolResult({
        status: "UNKNOWN", orderId, orderType, requestedSize, filledSize: null, remainingSize: null, tradeIds: [],
        message: "Polymarket rejected L2 order-status authentication (HTTP 401); verify the CLOB credentials. Order status is unconfirmed.",
        errorCode: "PS_CLOB_PRIVATE_AUTH_REJECTED", httpStatus: result.status,
      }, "get_order_status");
      if (result.status === 404) return tradeToolResult({
        status: "UNKNOWN", orderId, orderType, requestedSize, filledSize: null, remainingSize: null, tradeIds: [],
        message: "Polymarket returned HTTP 404 for this order ID; no order record was found.",
        errorCode: "PS_ORDER_NOT_FOUND", httpStatus: result.status,
      }, "get_order_status");
      if (result.status < 200 || result.status >= 300) return tradeToolResult({
        status: "UNKNOWN", orderId, orderType, requestedSize, filledSize: null, remainingSize: null, tradeIds: [],
        message: `${clobPrivateHttpFailure(result.status).message} Order status is unconfirmed.`,
        errorCode: clobPrivateHttpFailure(result.status).code,
        httpStatus: result.status,
      }, "get_order_status");
      const known = result.data === null ? null : orderStatusResult({ orderId, requestedSize, record: result.data, orderType });
      if (known === null) return tradeToolResult({
        status: "UNKNOWN", orderId, orderType, requestedSize, filledSize: null, remainingSize: null, tradeIds: [],
        message: "Polymarket returned no authoritative order record.", errorCode: "PS_ORDER_STATUS_UNKNOWN", httpStatus: result.status,
      }, "get_order_status");
      return tradeToolResult({ ...known, httpStatus: result.status }, "get_order_status");
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
      let credentials: ClobCredentials;
      try {
        credentials = await deriveClobCredentials(clobAuth, signerAddress);
      } catch (error) {
        const failure = clobRequestFailure(error, "PS_CLOB_AUTH_FAILED", "Polymarket CLOB credentials could not be derived.");
        return tradeToolResult({
          status: "FAILED", orderId, orderType: FAK, requestedSize, filledSize: null, remainingSize: null, tradeIds: [],
          message: failure.message, errorCode: failure.code,
          ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
        }, "cancel_order");
      }
      const reconcileCancellation = async (deleteStatus?: number) => {
        const readback = await sdkReadOrder(credentials, orderId).catch(() => null);
        const known = readback?.status === 200 && readback.data !== null
          ? orderStatusResult({ orderId, requestedSize, record: readback.data }) : null;
        if (known && known.status !== "UNKNOWN") return tradeToolResult({ ...known, httpStatus: deleteStatus ?? readback?.status }, "cancel_order");
        const httpStatus = deleteStatus ?? readback?.status;
        return tradeToolResult({
          status: "UNKNOWN", orderId, orderType: FAK, requestedSize,
          filledSize: null, remainingSize: null, tradeIds: [],
          message: "Cancellation was not authoritatively confirmed. Inspect the order before any further cancellation request.",
          errorCode: "PS_CANCEL_UNKNOWN", ...(httpStatus === undefined ? {} : { httpStatus }),
        }, "cancel_order");
      };
      let canceled: { status: number; data: unknown | null };
      try {
        canceled = await sdkResponse(() => credentials.cancelOrder({ orderId }));
      } catch {
        return reconcileCancellation();
      }
      if (canceled.status >= 400 && canceled.status < 500 && canceled.status !== 408 && canceled.status !== 429) {
        const failure = clobPrivateHttpFailure(canceled.status);
        return tradeToolResult({
          status: canceled.status === 400 ? "REJECTED" : "FAILED", orderId, orderType: FAK, requestedSize,
          filledSize: null, remainingSize: null, tradeIds: [], message: failure.message,
          errorCode: failure.code, httpStatus: canceled.status,
        }, "cancel_order");
      }
      if (canceled.status === 408 || canceled.status === 429 || canceled.status >= 500) {
        return reconcileCancellation(canceled.status);
      }
      if (canceled.status >= 200 && canceled.status < 300 && canceled.data !== null) {
        const result = z.object({ canceled: z.array(z.string()).optional(), not_canceled: z.record(z.string(), z.string()).optional() }).passthrough().safeParse(canceled.data);
        if (result.success && result.data.canceled?.some((id) => id.toLowerCase() === orderId.toLowerCase())) return tradeToolResult({
          status: "CANCELLED", orderId, orderType: FAK, requestedSize, filledSize: null, remainingSize: null, tradeIds: [],
          message: "Polymarket confirmed the order cancellation.", httpStatus: canceled.status,
        }, "cancel_order");
        if (result.success && result.data.not_canceled && Object.keys(result.data.not_canceled).some((id) => id.toLowerCase() === orderId.toLowerCase())) return tradeToolResult({
          status: "REJECTED", orderId, orderType: FAK, requestedSize, filledSize: null, remainingSize: null, tradeIds: [],
          message: "Polymarket did not cancel the requested order.", errorCode: "PS_CLOB_REJECTED", httpStatus: canceled.status,
        }, "cancel_order");
      }
      return reconcileCancellation(canceled.status);
    },
  );

  server.registerTool(
    "get_trading_readiness",
    {
      title: "Read Polymarket trading readiness",
      description: "Reads official SDK indexed trading-approval state for the supplied public account wallet. Funding, gas and exact order-size sufficiency remain UNKNOWN. Optional marketId/side are retained for compatibility; this is an aggregate SDK approval summary. Never signs, approves, funds, or sends transactions.",
      inputSchema: z.object({
        walletAddress: addressSchema, walletType: walletTypeSchema,
        marketId: z.string().regex(/^[0-9]{1,32}$/).optional(), side: sideSchema.optional(),
      }).strict(),
      outputSchema: tradingReadinessSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ walletAddress, walletType }) => {
      const state = await runSdk(() => createPolymarketClient().fetchTradingApprovalsState({ user: walletAddress })).catch(() => null);
      return textToolResult("get_trading_readiness", tradingReadinessSchema.parse({
        status: state && !state.isFullyApproved ? "ACTION_REQUIRED" : "UNKNOWN",
        wallet: { address: getAddress(walletAddress), type: walletType, addressRole: "ACCOUNT_WALLET" },
        chainId: 137, observedAt: new Date().toISOString(),
        pUsdBalance: { baseUnits: null, formatted: null, decimals: 6, status: "UNKNOWN" }, polBalance: null,
        approval: { kind: null, target: null, tokenLedger: null, allowanceBaseUnits: null,
          status: state ? state.isFullyApproved ? "PRESENT" : "MISSING" : "UNKNOWN" },
        eoaTradingEligibility: walletType === "EOA" ? "UNKNOWN" : "NOT_APPLICABLE",
        reason: state ? "Official SDK indexed trading-approval state; funding, gas, freshness and order-size sufficiency remain UNKNOWN." : "Official SDK trading-approval state is unavailable.",
        nextAction: state && !state.isFullyApproved ? "EXTERNAL_ACTION_REQUIRED: Review missing approvals in the official Polymarket wallet flow." : null,
      }));
    },
  );

  server.registerTool(
    "prepare_redeem",
    {
      title: "Prepare a Polymarket redemption preview",
      description: "Uses official SDK indexed positions and redemption workflows for the explicitly supplied owner. Accepts reusable signed ClobAuth and owner signingAddress for the SDK client. Returns an unsigned preview with EXTERNAL_ACTION_REQUIRED; route approval, fresh chain finality, and Polygon PayBox proposal support remain unverified. Never signs, submits approvals, or broadcasts.",
      inputSchema: z.object({
        walletAddress: addressSchema, walletType: walletTypeSchema, signingAddress: addressSchema, clobAuth: clobAuthSchema,
        conditionId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      }).strict(),
      outputSchema: preparedRedeemSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ walletAddress, walletType, conditionId, signingAddress, clobAuth }) => {
      const base = { conditionId, wallet: { address: getAddress(walletAddress), type: walletType, addressRole: "POSITION_OWNER" },
        market: { marketId: null, question: null, version: null, negRisk: null }, resolution: "UNKNOWN", positionLedger: "UNKNOWN",
        positions: [], routeApproval: null, transactionPreview: [], execution: "NOT_READY", missingRequirements: [], unknownRequirements: [], nextActions: [], errorCode: null };
      try {
        const client = await deriveClobCredentials(clobAuth, signingAddress, walletAddress);
        if (["EOA", "PROXY", "SAFE", "DEPOSIT_WALLET"][client.account.walletType] !== walletType) throw new Error("PS_WALLET_BINDING: Account type differs from SDK identity.");
        const page = await runSdk(() => client.listPositions({ user: walletAddress, conditionId, pageSize: 3 }).firstPage());
        if (page.hasMore || page.items.some((position) => position.wallet.toLowerCase() !== walletAddress.toLowerCase() || position.conditionId.toLowerCase() !== conditionId.toLowerCase())) {
          throw new Error("PS_MARKET_IDENTITY: Position page is incomplete or differs from the requested owner and condition.");
        }
        const held = page.items.filter((position) => toUnits(position.currentSize, 6) > 0n);
        const positions = held.map((position) => ({ outcome: position.outcome ?? "Unknown", tokenId: position.assetId,
          balanceBaseUnits: toUnits(position.currentSize, 6).toString(), ownership: "HELD" }));
        if (!held.length) return textToolResult("prepare_redeem", preparedRedeemSchema.parse({ ...base, status: "NO_POSITION" }));
        if (held.some((position) => !position.redeemable || position.status !== "REDEEMABLE")) {
          return textToolResult("prepare_redeem", preparedRedeemSchema.parse({ ...base, status: "UNRESOLVED", positions,
            unknownRequirements: ["The official indexed position state does not mark every held outcome redeemable."] }));
        }
        const markets = await runSdk(() => client.listMarkets({ conditionIds: [conditionId], pageSize: 1 }).firstPage());
        const market = markets.items[0];
        if (!market || market.conditionId?.toLowerCase() !== conditionId.toLowerCase()) throw new Error("PS_MARKET_IDENTITY: No exact SDK market match.");
        const assets = [market.outcomes.yes, market.outcomes.no].map((outcome) => outcome.positionId ?? outcome.tokenId);
        if (held.some((position) => !assets.includes(position.assetId))) throw new Error("PS_MARKET_IDENTITY: Indexed position asset differs from SDK market outcomes.");
        if (walletType !== "EOA") return textToolResult("prepare_redeem", preparedRedeemSchema.parse({ ...base,
          status: "UNSUPPORTED", execution: "EXTERNAL_ACTION_REQUIRED", positions,
          unknownRequirements: ["The public SDK gasless-wallet workflow requires relayer authorization and signing before direct calls can be exposed; PolyScope supplies neither."],
          nextActions: ["Use the official authorized wallet redemption flow. No approval, signing or broadcast was requested."],
        }));
        const requests = market.version === "v2" ? held.map((position) => ({ positionId: position.assetId })) : [{ conditionId }];
        const previews: z.infer<typeof transactionPreviewSchema>[] = [];
        for (const request of requests) {
          const workflow = "positionId" in request ? await runSdk(() => prepareRedeemPosition(client, request)) : await runSdk(() => prepareRedeemMarketPositions(client, request));
          try {
            const step = await runSdk(() => workflow.next());
            if (!step.done && step.value.kind === "sendRedeemPositionsTransaction") {
              previews.push({ from: getAddress(walletAddress), to: step.value.request.to, value: "0", data: step.value.request.data ?? "0x" });
            }
          } finally { await workflow.return(undefined!); }
        }
        return textToolResult("prepare_redeem", preparedRedeemSchema.parse({ ...base,
          market: { marketId: market.id, question: market.question ?? null, version: market.version ?? null, negRisk: market.state.negRisk ?? null },
          positionLedger: market.version === "v2" ? "PositionManager" : market.state.negRisk ? "NegRisk Adapter" : "Conditional Tokens",
          positions, status: previews.length === requests.length ? "PREPARED" : "UNSUPPORTED", transactionPreview: previews,
          execution: "EXTERNAL_ACTION_REQUIRED",
          unknownRequirements: ["Indexed redeemability is not fresh chain finality. Route approval and Polygon transaction-proposal validation are unverified."],
          nextActions: [previews.length ? "Review SDK-generated unsigned calls in an authorized official wallet flow. No transaction was signed or broadcast."
            : "The SDK requests a gasless-wallet signature before exposing direct calls. Complete redemption in the official wallet flow."],
        }));
      } catch {
        return textToolResult("prepare_redeem", preparedRedeemSchema.parse({ ...base, status: "UNKNOWN",
          unknownRequirements: ["Official SDK redemption preparation could not be completed."], errorCode: "PS_MARKET_DATA_UNAVAILABLE" }));
      }
    },
  );

  server.registerTool(
    "get_portfolio",
    {
      title: "Read public Polymarket positions and PnL",
      description: "Reads one cursor-paginated page of the default OPEN single-market positions and PnL view from Polymarket Data API v2. OPEN may include held REDEEMABLE positions after resolution; these rows are preserved. Pass nextCursor to continue; complete is true only after the final page of this view. The caller-provided address is not proof of wallet ownership. Closed positions and combos are not included.",
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
      return textToolResult("get_portfolio", {
        walletAddress, addressBinding: "PUBLIC_ADDRESS_UNVERIFIED", observedAt: new Date().toISOString(),
        sourceUrl: url.toString(), positions, complete: !pagination.has_more,
        hasMore: pagination.has_more, nextCursor: pagination.next_cursor,
      });
    },
  );

  return server;
}

serveStdio(createServer, { legacy: "reject" });
