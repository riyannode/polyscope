const scenario = process.env.POLYSCOPE_TEST_SCENARIO;
const ageScenario = /^book-(\d+)$/.exec(scenario ?? "");
if (ageScenario || scenario === "invalid-timestamp" || scenario === "future-timestamp") {
  const observedNow = Date.now();
  Date.now = () => observedNow;
}
if (scenario === "unexpected-failure") {
  Object.defineProperty(globalThis.crypto, "getRandomValues", { value: () => { throw new Error("fixture unexpected programming failure"); } });
}
let orderPosts = 0;

const conditionId = `0x${"1".repeat(64)}`;
const market = {
  id: "1", question: "Will the sample team win?", description: "The sample market resolves from the match result.",
  resolutionSource: "https://example.test/rules", conditionId,
  outcomes: JSON.stringify(["Yes", "No"]), clobTokenIds: JSON.stringify(["123", "124"]),
  outcomePrices: JSON.stringify(["0.50", "0.50"]), active: true, closed: false,
  restricted: false, acceptingOrders: true, enableOrderBook: true, negRisk: false, version: "v1",
};

const competitionNames = { PL: "Premier League", PD: "LaLiga", SA: "Serie A", CL: "UEFA Champions League" };
const footballCompetitionIds = { PL: "2021", PD: "2014", SA: "2019", CL: "2001" };
function match(id, competition, date, status = "SCHEDULED") {
  return {
    id, utcDate: `${date}T19:00:00Z`, status, lastUpdated: "2026-10-16T12:00:00Z",
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
  if (url.hostname === "gamma-api.polymarket.com" && url.pathname === "/markets/1") {
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
      bids: [{ price: "0.49", size: "100" }], asks: [{ price: "0.50", size: "100" }],
      min_order_size: "5", tick_size: "0.01", neg_risk: false, version: "v1",
    };
    if (scenario === "no-visible-liquidity") body.asks = [];
    if (scenario === "wrong-book") body.asset_id = "999";
    if (scenario === "invalid-timestamp") body.timestamp = "0";
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
    if (!["submit-valid", "restricted-submit", "submit-stale-book", "submit-stale-auth", "submit-ambiguous"].includes(scenario) || orderPosts !== 1) process.exit(89);
    const postedOrder = JSON.parse(init.body);
    if (postedOrder.orderType !== "FAK" || postedOrder.order.side !== "BUY"
      || postedOrder.order.makerAmount !== "5000000" || postedOrder.order.takerAmount !== "10000000"
      || postedOrder.order.timestamp === undefined || !postedOrder.order.signature) process.exit(90);
    if (scenario === "submit-ambiguous") throw new Error("fixture connection reset after request body");
    if (["submit-valid", "restricted-submit", "submit-stale-book", "submit-stale-auth"].includes(scenario)) {
      return new Response(JSON.stringify({ success: true, orderID: `0x${"a".repeat(64)}`, status: "MATCHED", tradeIDs: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: false, errorMsg: "offline fixture blocks order submission; attempts=1" }), {
      status: 403, headers: { "content-type": "application/json" },
    });
  } else if (url.hostname === "polymarket.com" && url.pathname === "/api/geoblock") {
    body = { blocked: scenario === "geoblocked" };
  } else if (url.hostname === "api.football-data.org" && url.pathname.startsWith("/v4/competitions/")) {
    const league = url.pathname.split("/")[3];
    if (url.searchParams.get("dateFrom") === "2026-11-01") return new Response("provider unavailable", { status: 403 });
    body = { matches: [match(({ PL: 1001, PD: 2001, SA: 3001, CL: 4001 })[league], league, "2026-10-17")] };
  } else if (url.hostname === "api.football-data.org" && url.pathname === "/v4/matches/9999") {
    body = match(9999, "PL", "2026-10-20");
    body.homeTeam = { id: 999, name: "Incomplete History FC" };
    body.awayTeam = { id: 998, name: "Opponent FC" };
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
    const id = Number(url.pathname.split("/").at(-1));
    const league = ({ 1001: "PL", 2001: "PD", 3001: "SA", 4001: "CL" })[id];
    body = match(id, league, "2026-10-17");
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
        : allCompetitionHistory(teamId);
    body = { matches: matches.slice(0, Number(url.searchParams.get("limit") ?? "100")) };
  } else if (url.hostname === "www.espn.com" && url.pathname === "/espn/rss/soccer/news") {
    const publishedAt = new Date().toUTCString();
    body = `<?xml version="1.0"?><rss><channel><item><title>Arsenal confirms training update</title><link>https://www.espn.com/soccer/story/1</link><description>Arsenal update.</description><pubDate>${publishedAt}</pubDate></item><item><title>General football headline</title><link>https://www.espn.com/soccer/story/2</link><pubDate>${publishedAt}</pubDate></item></channel></rss>`;
    return new Response(body, { headers: { "content-type": "application/rss+xml" } });
  } else if (url.hostname === "data-api.polymarket.com" && url.pathname === "/v2/positions") {
    const secondPage = url.searchParams.get("cursor") === "fixture-next-page";
    body = {
      data: [secondPage ? { ...portfolioPosition, condition_id: `0x${"3".repeat(64)}`, token_id: "789" } : portfolioPosition],
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
