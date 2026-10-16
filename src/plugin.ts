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
import * as z from "zod/v4";

const PROTOCOL_VERSION = "2026-07-28";
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
  conditionId: z.string().nullable().optional(),
  outcomes: z.union([z.string(), z.array(z.string())]).optional(),
  clobTokenIds: z.union([z.string(), z.array(z.string())]).optional(),
  positionIds: z.array(z.string()).nullable().optional(),
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
  min_order_size: z.string(),
  tick_size: z.enum(TICK_SIZES),
  neg_risk: z.boolean(),
  version: z.enum(["v1", "v2"]).nullable().optional(),
}).strip();

const marketResultSchema = z.object({
  eventTitle: z.string(), marketId: z.string(), question: z.string(), slug: z.string().nullable(),
  conditionId: z.string(), version: z.enum(["v1", "v2"]).nullable(), negRisk: z.boolean(),
  marketRestricted: z.boolean().nullable(), acceptingOrders: z.boolean().nullable(),
  endDate: z.string().nullable(), yesAssetId: decimalIdSchema, noAssetId: decimalIdSchema,
}).strict();
const typedOutputSchema = z.object({
  signingAddress: addressSchema,
  timestamp: z.string(),
  nonce: z.string(),
  typedData: typedDataSchema,
  requestWalletSignIntent: requestWalletSignIntentSchema,
}).strict();
const walletTypeSchema = z.enum(["EOA", "PROXY", "SAFE", "DEPOSIT_WALLET"]);
const sideSchema = z.enum(["BUY", "SELL"]);
const preparedOrderBaseSchema = z.object({
  market: z.object({
    id: z.string(), conditionId: z.string(), version: z.enum(["v1", "v2"]), negRisk: z.boolean(),
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
      description: "Find active YES/NO Polymarket markets and their outcome identifiers. This reads public Gamma API data only.",
      inputSchema: z.object({ query: z.string().min(2).max(100), limit: z.number().int().min(1).max(5).default(3) }).strict(),
      outputSchema: z.object({ markets: z.array(marketResultSchema), resultCount: z.number().int() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, limit }) => {
      const url = new URL("https://gamma-api.polymarket.com/public-search");
      url.searchParams.set("q", query);
      const response = searchResponseSchema.parse(await getJson(url.toString()));
      const markets: z.infer<typeof marketResultSchema>[] = [];
      for (const event of response.events.slice(0, limit)) {
        for (const market of event.markets) {
          if (market.active !== true || market.closed !== false || market.enableOrderBook === false) continue;
          if (!market.conditionId || !market.question || market.negRisk === undefined || market.version === undefined || market.version === null) continue;
          const outcomes = parseJsonArray(market.outcomes);
          const tokenIds = marketAssetIds(market);
          if (outcomes.length !== 2 || tokenIds.length !== 2) continue;
          const yesIndex = outcomes.findIndex((item) => item.toLowerCase() === "yes");
          const noIndex = outcomes.findIndex((item) => item.toLowerCase() === "no");
          const yesAssetId = yesIndex < 0 ? undefined : tokenIds[yesIndex];
          const noAssetId = noIndex < 0 ? undefined : tokenIds[noIndex];
          if (!yesAssetId || !noAssetId || !decimalIdSchema.safeParse(yesAssetId).success || !decimalIdSchema.safeParse(noAssetId).success) continue;
          markets.push({
            eventTitle: event.title ?? market.question,
            marketId: String(market.id),
            question: market.question,
            slug: market.slug ?? null,
            conditionId: market.conditionId,
            version: market.version,
            negRisk: market.negRisk,
            marketRestricted: market.restricted ?? null,
            acceptingOrders: market.acceptingOrders ?? null,
            endDate: market.endDate ?? null,
            yesAssetId,
            noAssetId,
          });
          if (markets.length >= 20) break;
        }
        if (markets.length >= 20) break;
      }
      return {
        content: [{ type: "text", text: `Found ${markets.length} active YES/NO markets.` }],
        structuredContent: { markets, resultCount: markets.length },
      };
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
      const outcomes = parseJsonArray(market.outcomes);
      const tokenIds = marketAssetIds(market);
      if (outcomes.length !== 2 || tokenIds.length !== 2 || !tokenIds.includes(assetId)) {
        throw new Error("The asset ID is not one of this market's binary outcome IDs.");
      }
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
          id: marketId, conditionId: market.conditionId, version: market.version,
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
