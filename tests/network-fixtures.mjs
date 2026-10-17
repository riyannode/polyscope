import { decodeFunctionData, encodeAbiParameters, parseAbi } from "viem";

const scenario = process.env.POLYSCOPE_TEST_SCENARIO;
const ageScenario = /^book-(\d+)$/.exec(scenario ?? "");
if (ageScenario || scenario === "invalid-timestamp" || scenario === "future-timestamp") {
  const observedNow = Date.now();
  Date.now = () => observedNow;
}
if (scenario === "analysis-fixed-clock") Date.now = () => Date.parse("2026-10-17T04:23:29.396Z");
if (scenario === "unexpected-failure") {
  Object.defineProperty(globalThis.crypto, "getRandomValues", { value: () => { throw new Error("fixture unexpected programming failure"); } });
}
let orderPosts = 0;
process.on("exit", () => {
  if (scenario?.startsWith("snapshot-") && !["snapshot-min-increase", "snapshot-min-zero", "snapshot-tick-invalid", "snapshot-risk-changed"].includes(scenario) && orderPosts !== 1) process.exitCode = 92;
  if (["snapshot-min-increase", "snapshot-min-zero", "snapshot-tick-invalid", "snapshot-risk-changed"].includes(scenario) && orderPosts !== 0) process.exitCode = 93;
});

const conditionId = `0x${"1".repeat(64)}`;
const v2ConditionId = `0x01${"11".repeat(30)}00`;
const v2PositionIds = [BigInt(v2ConditionId).toString(), (BigInt(v2ConditionId) + 1n).toString()];
const rpcReadAbis = {
  erc20: parseAbi(["function balanceOf(address account) view returns (uint256)", "function allowance(address owner, address spender) view returns (uint256)"]),
  erc1155: parseAbi(["function balanceOf(address account, uint256 id) view returns (uint256)", "function isApprovedForAll(address account, address operator) view returns (bool)"]),
  ctf: parseAbi(["function payoutDenominator(bytes32 conditionId) view returns (uint256)"]),
  positionManager: parseAbi(["function moduleById(uint8 moduleId) view returns (address)"]),
  v2Module: parseAbi(["function hasResult(bytes31 conditionId) view returns (bool)"]),
};
function rpcWord(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}
const market = {
  id: "1", question: "Will the sample team win?", description: "The sample market resolves from the match result.",
  resolutionSource: "https://example.test/rules", conditionId,
  outcomes: JSON.stringify(["Yes", "No"]), clobTokenIds: JSON.stringify(["123", "124"]),
  outcomePrices: JSON.stringify(["0.50", "0.50"]), active: true, closed: false,
  restricted: false, acceptingOrders: true, enableOrderBook: true, negRisk: false, version: "v1",
};

const competitionNames = { PL: "Premier League", PD: "LaLiga", SA: "Serie A", CL: "UEFA Champions League" };
const footballCompetitionIds = { PL: "2021", PD: "2014", SA: "2019", CL: "2001" };
const apiFootballLeagueNames = { PL: "Premier League", PD: "La Liga", SA: "Serie A", CL: "UEFA Champions League" };
function match(id, competition, date, status = "SCHEDULED") {
  return {
    id, utcDate: `${date}T19:00:00Z`, status, lastUpdated: "2026-10-16T12:00:00Z",
    season: { startDate: "2026-08-01", endDate: "2027-05-31" },
    competition: { id: Number(footballCompetitionIds[competition]), code: competition, name: competitionNames[competition] },
    homeTeam: { id: 101, name: "Arsenal" }, awayTeam: { id: 202, name: "Chelsea" },
    score: { fullTime: { home: status === "FINISHED" ? 2 : null, away: status === "FINISHED" ? 1 : null } },
  };
}
function matchAt(id, competition, utcDate, status, teamId) {
  const fixture = match(id, competition, utcDate.slice(0, 10), status);
  fixture.utcDate = utcDate;
  fixture.homeTeam = { id: teamId, name: teamId === 402 ? "Brentford FC" : "Liverpool FC" };
  fixture.awayTeam = { id: 303, name: "Sample opponent" };
  return fixture;
}
const portfolioPosition = {
  archived: false, avg_price: 0.42, condition_id: `0x${"2".repeat(64)}`, current_price: 0.51,
  current_size: 12, current_value: 6.12, end_date: "2026-12-31T00:00:00Z", entry_cost_usdc: 5.04,
  entry_fees_usdc: 0.02, event_id: "101", event_slug: "sample-event", first_entry_at: 1792231200,
  icon: "https://example.test/market.png", last_event_at: 1792231200, mergeable: false,
  name: "Sample outcome", negative_risk: false, opposite_outcome: "No", opposite_token_id: "456",
  outcome: "Yes", outcome_index: 0, percent_pnl: 21.03, percent_realized_pnl: 0,
  profile_image: "https://example.test/profile.png", proxy_wallet: "0x0000000000000000000000000000000000000001",
  realized_pnl: 0, redeemable: false, slug: "sample-market", status: "OPEN", title: "Sample market title",
  token_id: "123", total_cost_usdc: 5.06, total_pnl: 1.06, total_size: 12, unrealized_pnl: 1.06, verified: false,
};
const history = (teamId, competition = "PL") => Array.from({ length: 5 }, (_, index) => {
  const homeId = index % 2 === 0 ? teamId : 303;
  const awayId = index % 2 === 0 ? 303 : teamId;
  return {
    ...match(Number(footballCompetitionIds[competition]) * 100_000 + teamId * 10 + index, competition, `2026-10-${String(10 - index).padStart(2, "0")}`, "FINISHED"),
    homeTeam: { id: homeId, name: homeId === teamId ? (teamId === 101 ? "Arsenal" : "Chelsea") : "Liverpool" },
    awayTeam: { id: awayId, name: awayId === teamId ? (teamId === 101 ? "Arsenal" : "Chelsea") : "Liverpool" },
  };
});
const allCompetitionHistory = (teamId) => Object.keys(footballCompetitionIds).flatMap((league) => history(teamId, league));
const mixedHistory = (teamId) => [
  matchAt(91001, "PL", "2026-10-17T12:00:00Z", "FINISHED", teamId),
  matchAt(91002, "CL", "2026-10-16T20:00:00Z", "FINISHED", teamId),
  matchAt(91003, "PL", "2026-10-16T19:00:00Z", "FINISHED", teamId),
  matchAt(91004, "PL", "2026-10-15T19:00:00Z", "FINISHED", teamId),
  matchAt(91005, "PL", "2026-10-14T19:00:00Z", "FINISHED", teamId),
  matchAt(91006, "PL", "2026-10-13T19:00:00Z", "FINISHED", teamId),
  matchAt(560611, "PL", "2026-10-17T19:00:00Z", "FINISHED", teamId),
  matchAt(91007, "PL", "2026-10-17T10:00:00Z", "SCHEDULED", teamId),
];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  let body;
  if (url.hostname === "polygon.drpc.org") {
    const request = JSON.parse(init.body);
    const rpcResponse = (entry) => {
      if (["eth_sendTransaction", "eth_sendRawTransaction", "personal_sign", "eth_signTypedData_v4"].includes(entry.method)) process.exit(110);
      if (scenario === "chain-read-unavailable") return { jsonrpc: "2.0", id: entry.id, error: { code: -32000, message: "fixture RPC unavailable" } };
      if (entry.method === "eth_chainId") return { jsonrpc: "2.0", id: entry.id, result: "0x89" };
      if (entry.method === "eth_blockNumber") return { jsonrpc: "2.0", id: entry.id, result: "0x100" };
      if (entry.method === "eth_getBalance") {
        const address = entry.params[0].toLowerCase();
        const isEmpty = scenario === "readiness-empty";
        const balance = isEmpty || address.endsWith("0002") ? 0n : 1_000_000_000_000_000_000n;
        return { jsonrpc: "2.0", id: entry.id, result: `0x${balance.toString(16)}` };
      }
      if (entry.method !== "eth_call") process.exit(111);
      const call = entry.params[0];
      const target = call.to.toLowerCase();
      let decoded;
      let value;
      if (target === "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb") {
        decoded = decodeFunctionData({ abi: rpcReadAbis.erc20, data: call.data });
        if (decoded.functionName === "balanceOf") {
          const owner = decoded.args[0].toLowerCase();
          value = scenario === "readiness-empty" || owner.endsWith("0002") ? 0n : 8_500_000n;
        } else {
          const allowance = scenario === "readiness-empty" || scenario === "readiness-missing-approvals" ? 0n : 100_000_000n;
          value = allowance;
        }
      } else if (target === "0x4d97dcd97ec945f40cf65f87097ace5ea0476045") {
        try { decoded = decodeFunctionData({ abi: rpcReadAbis.erc1155, data: call.data }); }
        catch { decoded = decodeFunctionData({ abi: rpcReadAbis.ctf, data: call.data }); }
        if (decoded.functionName === "payoutDenominator") value = scenario === "redeem-unresolved" ? 0n : 1n;
        else if (decoded.functionName === "isApprovedForAll") {
          value = scenario === "readiness-missing-approvals" || scenario === "redeem-missing-approval" ? 0n : 1n;
        } else {
          const owner = decoded.args[0].toLowerCase();
          const tokenId = decoded.args[1];
          const noPosition = scenario === "redeem-wrong-owner" || scenario === "redeem-insufficient-balance" || owner.endsWith("0002") || scenario === "readiness-empty";
          value = noPosition ? 0n : tokenId === BigInt("123") ? 10_000_000n : 0n;
        }
      } else if (target === "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296") {
        decoded = decodeFunctionData({ abi: rpcReadAbis.erc1155, data: call.data });
        const owner = decoded.args[0].toLowerCase();
        const noPosition = scenario === "redeem-wrong-owner" || scenario === "redeem-insufficient-balance" || owner.endsWith("0002") || scenario === "readiness-empty";
        value = noPosition ? 0n : decoded.args[1] === BigInt("123") ? 10_000_000n : 0n;
      } else if (target === "0x006f54f7f9a22e0000cc2ab60031000000ae9fef") {
        try { decoded = decodeFunctionData({ abi: rpcReadAbis.erc1155, data: call.data }); }
        catch { decoded = decodeFunctionData({ abi: rpcReadAbis.positionManager, data: call.data }); }
        if (decoded.functionName === "moduleById") {
          value = "0x00000000000000000000000000000000000000a1";
        } else if (decoded.functionName === "isApprovedForAll") {
          value = scenario === "readiness-missing-approvals" || scenario === "redeem-missing-approval" ? 0n : 1n;
        } else {
          const owner = decoded.args[0].toLowerCase();
          const tokenId = decoded.args[1];
          const noPosition = scenario === "redeem-wrong-owner" || scenario === "redeem-insufficient-balance" || owner.endsWith("0002") || scenario === "readiness-empty";
          value = noPosition ? 0n : scenario.startsWith("redeem-v2") && tokenId === BigInt(v2PositionIds[0]) ? 10_000_000n : 0n;
        }
      } else if (target === "0x00000000000000000000000000000000000000a1") {
        decoded = decodeFunctionData({ abi: rpcReadAbis.v2Module, data: call.data });
        value = scenario === "redeem-v2-unresolved" ? 0n : 1n;
      } else {
        process.exit(112);
      }
      const result = typeof value === "string"
        ? encodeAbiParameters([{ type: "address" }], [value])
        : typeof value === "boolean"
        ? encodeAbiParameters([{ type: "bool" }], [value])
        : rpcWord(value);
      return { jsonrpc: "2.0", id: entry.id, result };
    };
    const rpcResult = Array.isArray(request) ? request.map(rpcResponse) : rpcResponse(request);
    return Response.json(rpcResult);
  }
  if (url.hostname === "gamma-api.polymarket.com" && url.pathname === "/markets") {
    const requestedCondition = url.searchParams.get("condition_ids")?.toLowerCase();
    if (requestedCondition === v2ConditionId && scenario?.startsWith("redeem-v2")) {
      body = [{ ...market, conditionId: v2ConditionId, version: "v2", positionIds: v2PositionIds }];
    } else if (requestedCondition === conditionId) {
      body = [{ ...market, ...(scenario === "redeem-negative-risk" ? { negRisk: true } : {}) }];
    } else {
      body = [];
    }
  } else if (url.hostname === "gamma-api.polymarket.com" && url.pathname === "/markets/1") {
    if (scenario === "provider-invalid-json") return new Response("{", { headers: { "content-type": "application/json" } });
    if (scenario === "provider-unavailable") return new Response("unavailable", { status: 503 });
    body = scenario === "provider-invalid" ? { id: false } : { ...market };
    if (scenario === "wrong-market") body.id = "2";
    if (scenario === "restricted-prepare" || scenario === "restricted-submit") body.restricted = true;
  } else if (url.hostname === "gamma-api.polymarket.com" && url.pathname === "/public-search") {
    body = { events: [{ title: "Sample event", markets: [{ ...market, restricted: true }] }] };
  } else if (url.hostname === "clob.polymarket.com" && url.pathname === "/book" && ["123", "124", "999"].includes(url.searchParams.get("token_id") ?? "")) {
    const assetId = url.searchParams.get("token_id");
    body = {
      asset_id: assetId, market: conditionId,
      timestamp: String(Date.now() - (ageScenario ? Number(ageScenario[1]) : scenario === "submit-stale-book" ? 51_000 : assetId === "124" ? 121_000 : 0)),
      bids: [{ price: "0.49", size: "100" }], asks: [{ price: "0.50", size: scenario === "analysis-partial-depth" ? "4" : "100" }],
      min_order_size: "5", tick_size: "0.01", neg_risk: false, version: "v1",
    };
    if (scenario === "analysis-multilevel") body.asks = [{ price: "0.50", size: "5" }, { price: "0.60", size: "100" }];
    if (scenario === "analysis-favorable") body.asks = [{ price: "0.25", size: "100" }];
    if (scenario === "snapshot-min-decrease") body.min_order_size = "1";
    if (scenario === "snapshot-min-increase") body.min_order_size = "11";
    if (scenario === "snapshot-min-zero") body.min_order_size = "0";
    if (scenario === "snapshot-tick-valid") body.tick_size = "0.005";
    if (scenario === "snapshot-tick-invalid") body.tick_size = "0.1";
    if (scenario === "snapshot-risk-changed") body.neg_risk = true;
    if (scenario === "submit-future-book") body.timestamp = String(Date.now() + 1);
    if (scenario === "missing-book-timestamp") delete body.timestamp;
    if (scenario === "no-visible-liquidity") body.asks = [];
    if (scenario === "wrong-book") body.asset_id = "999";
    if (scenario === "invalid-timestamp") body.timestamp = "not-a-timestamp";
    if (scenario === "future-timestamp") body.timestamp = String(Date.now() + 1);
    if (scenario === "invalid-level") body.asks = [{ price: "NaN", size: "100" }];
    if (scenario === "price-bound") body.asks = [{ price: "0.51", size: "100" }];
  } else if (url.hostname === "clob.polymarket.com" && url.pathname === `/clob-markets/${conditionId}`) {
    body = { fd: { r: scenario === "fee-changed" ? 0.06 : 0.05, e: 1 } };
  } else if (url.hostname === "clob.polymarket.com" && url.pathname === "/auth/derive-api-key") {
    if (scenario === "missing-credentials") return new Response("unauthorized", { status: 401 });
    body = { apiKey: "fixture-api-key", secret: "dGVzdA==", passphrase: "fixture-passphrase" };
  } else if (url.hostname === "clob.polymarket.com" && url.pathname.startsWith("/data/order/")) {
    return new Response("not found", { status: 404 });
  } else if (url.hostname === "clob.polymarket.com" && url.pathname === "/order" && init.method === "POST") {
    orderPosts += 1;
    if (!["submit-valid", "submit-deposit-wallet", "restricted-submit", "submit-stale-book", "submit-stale-auth", "submit-future-book", "missing-book-timestamp", "submit-ambiguous", "snapshot-min-decrease", "snapshot-tick-valid"].includes(scenario) || orderPosts !== 1) process.exit(89);
    const postedOrder = JSON.parse(init.body);
    if (postedOrder.orderType !== "FAK" || postedOrder.order.side !== "BUY"
      || postedOrder.order.makerAmount !== "5000000" || postedOrder.order.takerAmount !== "10000000"
      || postedOrder.order.timestamp === undefined || !postedOrder.order.signature) process.exit(90);
    if (scenario === "submit-deposit-wallet" && (postedOrder.order.signature.length <= 132 || postedOrder.order.signatureType !== 3)) process.exit(94);
    if (scenario === "submit-ambiguous") throw new Error("fixture connection reset after request body");
    if (["submit-valid", "submit-deposit-wallet", "restricted-submit", "submit-stale-book", "submit-stale-auth", "submit-future-book", "missing-book-timestamp", "snapshot-min-decrease", "snapshot-tick-valid"].includes(scenario)) {
      return new Response(JSON.stringify({ success: true, orderID: `0x${"a".repeat(64)}`, status: "MATCHED", tradeIDs: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: false, errorMsg: "offline fixture blocks order submission; attempts=1" }), {
      status: 403, headers: { "content-type": "application/json" },
    });
  } else if (url.hostname === "polymarket.com" && url.pathname === "/api/geoblock") {
    body = { blocked: scenario === "geoblocked" };
  } else if (url.hostname === "polygon-rpc.com") {
    process.exit(91);
  } else if (url.hostname === "v3.football.api-sports.io" && url.pathname === "/fixtures") {
    if (scenario === "no-unneeded-api") process.exit(97);
    if (["api-football-season-conflict", "api-football-season-invalid", "api-football-season-ambiguous"].includes(scenario)) process.exit(99);
    if (scenario === "api-football-403") return new Response("forbidden", { status: 403 });
    if (scenario === "api-football-204") return new Response(null, { status: 204 });
    if (scenario === "fallback-api-403") return new Response("forbidden", { status: 403 });
    if (scenario === "fallback-api-204") return new Response(null, { status: 204 });
    if (scenario === "fallback-api-invalid-json") return new Response("{", { headers: { "content-type": "application/json" } });
    if (scenario === "fallback-api-empty") return Response.json({ errors: [], response: [] });
    if (scenario === "fallback-api-invalid-shape") return Response.json({ errors: [], response: [{ fixture: { id: "bad" } }] });
    if (scenario === "api-football-oversized" || scenario === "fallback-api-oversized") return new Response("x".repeat(1_000_001));
    if (scenario === "api-football-wrong-league" || scenario === "fallback-api-wrong-league") return Response.json({ errors: [], response: [{
      fixture: { id: 90001, date: `${url.searchParams.get("date")}T19:00:00+00:00` }, league: { id: 140, name: "Premier League", season: Number(url.searchParams.get("season")) },
      teams: { home: { id: 501, name: "Arsenal FC" }, away: { id: 502, name: "Chelsea" } },
    }] });
    if (scenario === "api-football-wrong-season" || scenario === "fallback-api-wrong-season") return Response.json({ errors: [], response: [{
      fixture: { id: 90001, date: `${url.searchParams.get("date")}T19:00:00+00:00` }, league: { id: 39, name: "Premier League", season: 2025 },
      teams: { home: { id: 501, name: "Arsenal FC" }, away: { id: 502, name: "Chelsea" } },
    }] });
    if (scenario === "api-football-enrichment-cross-season" || scenario === "api-football-season-partial") return Response.json({ errors: [], response: [{
      fixture: { id: 90012, date: "2026-01-17T19:00:00+00:00" }, league: { id: 39, name: "Premier League", season: 2025 },
      teams: { home: { id: 501, name: "Arsenal FC" }, away: { id: 502, name: "Chelsea" } },
    }] });
    if (scenario === "fallback-cross-season") return Response.json({ errors: [], response: [{
      fixture: { id: 90011, date: "2026-01-17T19:00:00+00:00" }, league: { id: 39, name: "Premier League", season: 2025 },
      teams: { home: { id: 501, name: "Arsenal FC" }, away: { id: 502, name: "Chelsea" } },
    }] });
    if (scenario === "fallback-season-unknown") process.exit(98);
    if (scenario === "fallback-later-date") {
      const date = url.searchParams.get("date");
      const laterFixture = {
        fixture: { id: 90024, date: "2026-10-24T19:00:00+00:00" },
        league: { id: 39, name: apiFootballLeagueNames.PL, season: 2026 },
        teams: { home: { id: 501, name: "Arsenal FC" }, away: { id: 502, name: "Chelsea" } },
      };
      return Response.json({ errors: [], response: date === "2026-10-24" ? [laterFixture] : [] });
    }
    const kickoff = scenario === "api-football-kickoff-conflict" || scenario === "fallback-kickoff-conflict"
      ? "2026-10-17T20:00:00+00:00" : "2026-10-17T19:00:00+00:00";
    const fixture = {
      fixture: { id: 90001, date: kickoff },
      league: { id: 39, name: apiFootballLeagueNames.PL, season: 2026 },
      teams: { home: { id: 501, name: "Arsenal FC" }, away: { id: 502, name: "Chelsea" } },
    };
    const competitionFixtures = [fixture,
      { fixture: { id: 90002, date: "2026-10-17T19:00:00+00:00" }, league: { id: 140, name: apiFootballLeagueNames.PD, season: 2026 }, teams: { home: { id: 601, name: "Real Madrid" }, away: { id: 602, name: "Barcelona" } } },
      { fixture: { id: 90003, date: "2026-10-17T19:00:00+00:00" }, league: { id: 135, name: apiFootballLeagueNames.SA, season: 2026 }, teams: { home: { id: 701, name: "Inter" }, away: { id: 702, name: "Milan" } } },
      { fixture: { id: 90004, date: "2026-10-17T19:00:00+00:00" }, league: { id: 2, name: apiFootballLeagueNames.CL, season: 2026 }, teams: { home: { id: 801, name: "Paris Saint-Germain" }, away: { id: 802, name: "Bayern Munich" } } },
    ];
    body = scenario === "api-football-api-error" || scenario === "fallback-api-error" ? { errors: { token: "fixture detail suppressed" }, response: [] }
      : { errors: [], response: scenario === "api-football-mismatch" ? [] : scenario === "api-football-ambiguous" || scenario === "fallback-ambiguous" ? [fixture, { ...fixture, fixture: { ...fixture.fixture, id: 90005 } }] : competitionFixtures.filter((entry) =>
        entry.league.id === Number(url.searchParams.get("league")) && entry.league.season === Number(url.searchParams.get("season"))
          && entry.fixture.date.slice(0, 10) === url.searchParams.get("date")) };
  } else if (url.hostname === "v3.football.api-sports.io" && url.pathname === "/teams/statistics") {
    if (scenario === "api-football-stats-403" || scenario === "fallback-api-stats-403") return new Response("forbidden", { status: 403 });
    const home = url.searchParams.get("team") === "501";
    body = { response: {
      fixtures: { played: { home: scenario === "api-football-empty-stats" ? 0 : home ? 8 : 4, away: scenario === "api-football-empty-stats" ? 0 : home ? 5 : 6 } },
      goals: { for: { average: { home: scenario === "api-football-empty-stats" ? null : home ? "1.75" : "0.90", away: scenario === "api-football-empty-stats" ? null : home ? "1.10" : "1.20" } },
        against: { average: { home: scenario === "api-football-empty-stats" ? null : home ? "0.75" : "1.30", away: scenario === "api-football-empty-stats" ? null : home ? "1.40" : "1.60" } } },
    } };
  } else if (url.hostname === "api.football-data.org" && url.pathname.startsWith("/v4/competitions/")) {
    const league = url.pathname.split("/")[3];
    if (scenario === "fallback-range-conflict") throw new Error("unexpected provider request before fixture identity date validation");
    if (scenario?.startsWith("fallback-api-")) return new Response("provider unavailable", { status: 503 });
    if (scenario === "fallback-ambiguous" || scenario === "fallback-kickoff-conflict") return new Response("provider unavailable", { status: 503 });
    if (scenario === "fallback-network") throw new TypeError("fixture network unavailable");
    if (scenario === "fallback-timeout") throw new DOMException("fixture timed out", "TimeoutError");
    if (scenario === "fallback-http-401") return new Response("unauthorized", { status: 401 });
    if (scenario === "fallback-http-403") return new Response("forbidden", { status: 403 });
    if (scenario === "fallback-http-429") return new Response("rate limited", { status: 429 });
    if (scenario === "fallback-http-503") return new Response("provider unavailable", { status: 503 });
    if (scenario === "fallback-later-date" || scenario === "fallback-cross-season") return new Response("provider unavailable", { status: 503 });
    if (scenario === "fallback-invalid-json") return new Response("{", { headers: { "content-type": "application/json" } });
    if (scenario === "fallback-invalid-shape") return new Response(JSON.stringify({ matches: [{ id: "bad" }] }), { headers: { "content-type": "application/json" } });
    if (scenario === "fallback-empty") return Response.json({ matches: [] });
    if (scenario === "fallback-season-unknown") return new Response("provider unavailable", { status: 503 });
    if (url.searchParams.get("dateFrom") === "2026-11-01") return new Response("provider unavailable", { status: 403 });
    body = { matches: [match(({ PL: 1001, PD: 2001, SA: 3001, CL: 4001 })[league], league, "2026-10-17")] };
  } else if (url.hostname === "api.football-data.org" && url.pathname === "/v4/matches/9999") {
    body = match(9999, "PL", "2026-10-20");
    body.homeTeam = { id: 999, name: "Incomplete History FC" };
    body.awayTeam = { id: 998, name: "Opponent FC" };
  } else if (url.hostname === "api.football-data.org" && url.pathname === "/v4/matches/7777") {
    body = match(7777, "PL", "2026-10-20");
    body.homeTeam = { id: 777, name: "Complete History FC" };
    body.awayTeam = { id: 778, name: "Partial History FC" };
  } else if (url.hostname === "api.football-data.org" && url.pathname === "/v4/matches/7776") {
    body = match(7776, "PL", "2026-10-20");
    body.homeTeam = { id: 779, name: "No History Home FC" };
    body.awayTeam = { id: 780, name: "No History Away FC" };
  } else if (url.hostname === "api.football-data.org" && url.pathname === "/v4/matches/8888") {
    body = match(8888, "PL", "2026-10-21");
    body.homeTeam = { id: 888, name: "Permission Denied FC" };
    body.awayTeam = { id: 887, name: "Opponent FC" };
  } else if (url.hostname === "api.football-data.org" && url.pathname === "/v4/matches/8889") {
    body = match(8889, "SA", "2026-10-22");
    body.homeTeam = { id: 889, name: "Rate Limited FC" };
    body.awayTeam = { id: 886, name: "Opponent FC" };
  } else if (url.hostname === "api.football-data.org" && url.pathname === "/v4/matches/560611") {
    body = match(560611, "PL", "2026-10-17");
    body.homeTeam = { id: 402, name: "Brentford FC" };
    body.awayTeam = { id: 64, name: "Liverpool FC" };
  } else if (url.hostname === "api.football-data.org" && url.pathname.startsWith("/v4/matches/")) {
    if (scenario?.startsWith("fallback-api-")) return new Response("provider unavailable", { status: 503 });
    if (scenario === "fallback-exact-failure") return new Response("provider unavailable", { status: 503 });
    if (scenario === "fallback-network") throw new TypeError("fixture network unavailable");
    if (scenario === "fallback-timeout") throw new DOMException("fixture timed out", "TimeoutError");
    const id = Number(url.pathname.split("/").at(-1));
    const league = ({ 1001: "PL", 2001: "PD", 3001: "SA", 4001: "CL" })[id];
    body = ["api-football-enrichment-cross-season", "api-football-season-partial"].includes(scenario)
      ? match(id, league, "2026-01-17") : scenario === "api-football-season-ambiguous" ? match(id, league, "2026-06-17") : match(id, league, "2026-10-17");
    if (scenario === "api-football-season-conflict") body.season = { startDate: "2025-08-01", endDate: "2026-05-31" };
    if (scenario === "api-football-season-missing") body.season = { startDate: null, endDate: null };
    if (scenario === "api-football-season-partial") body.season = { startDate: "2025-08-01", endDate: null };
    if (scenario === "api-football-season-invalid") body.season = { startDate: "not-a-date", endDate: null };
    if (scenario === "api-football-season-ambiguous") body.season = { startDate: null, endDate: null };
    if (scenario === "api-football-enrichment-cross-season") body.season = { startDate: "2025-08-01", endDate: "2026-05-31" };
  } else if (url.hostname === "api.football-data.org" && url.pathname.startsWith("/v4/teams/")) {
    const teamId = Number(url.pathname.split("/")[3]);
    if (url.searchParams.has("dateTo")) return new Response(JSON.stringify({ message: "Provider rejected dateTo for team history." }), {
      status: 400, headers: { "content-type": "application/json" },
    });
    const unsupportedParameters = [...url.searchParams.keys()].filter((key) => !["competitions", "dateFrom", "dateTo", "season", "status", "venue", "limit"].includes(key));
    if (unsupportedParameters.length > 0) return new Response(JSON.stringify({ message: "Unsupported Team Match Subresource filter." }), {
      status: 400, headers: { "content-type": "application/json" },
    });
    if (teamId === 888) {
      return new Response(JSON.stringify({ message: "Subscription permission denied.", diagnostic: "sensitive provider detail" }), {
        status: 403, headers: { "content-type": "application/json" },
      });
    }
    if (teamId === 889) {
      return new Response(JSON.stringify({ message: "Rate limit reached." }), {
        status: 429, headers: { "content-type": "application/json" },
      });
    }
    if (teamId === 64) {
      return new Response(JSON.stringify({ message: "Team history unavailable for this account." }), {
        status: 403, headers: { "content-type": "application/json" },
      });
    }
    const matches = teamId === 402
      ? mixedHistory(teamId)
      : teamId === 999
        ? history(teamId).slice(0, 4)
        : teamId === 778
          ? history(teamId).slice(0, 4)
          : teamId === 779 || teamId === 780
            ? []
            : allCompetitionHistory(teamId);
    body = { matches: matches.slice(0, Number(url.searchParams.get("limit") ?? "100")) };
  } else if (url.hostname === "www.espn.com" && url.pathname === "/espn/rss/soccer/news") {
    const publishedAt = new Date().toUTCString();
    body = `<?xml version="1.0"?><rss><channel><item><title>Arsenal confirms training update</title><link>https://www.espn.com/soccer/story/1</link><description>Arsenal update.</description><pubDate>${publishedAt}</pubDate></item><item><title>General football headline</title><link>https://www.espn.com/soccer/story/2</link><pubDate>${publishedAt}</pubDate></item></channel></rss>`;
    return new Response(body, { headers: { "content-type": "application/rss+xml" } });
  } else if (url.hostname === "data-api.polymarket.com" && url.pathname === "/v2/positions") {
    const secondPage = url.searchParams.get("cursor") === "fixture-next-page";
    const position = scenario === "portfolio-redeemable" ? { ...portfolioPosition, redeemable: true, status: "REDEEMABLE" } : portfolioPosition;
    body = {
      data: [secondPage ? { ...position, condition_id: `0x${"3".repeat(64)}`, token_id: "789" } : position],
      pagination: {
        has_more: !secondPage,
        limit: 10,
        next_cursor: secondPage ? null : "fixture-next-page",
        offset: secondPage ? 10 : 0,
      },
    };
  } else {
    return new Response(JSON.stringify({ error: "unexpected fixture request" }), {
      status: 404, headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
};
