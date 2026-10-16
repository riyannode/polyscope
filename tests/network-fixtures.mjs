const conditionId = `0x${"1".repeat(64)}`;
const market = {
  id: "1", question: "Will the sample team win?", description: "The sample market resolves from the match result.",
  resolutionSource: "https://example.test/rules", conditionId,
  outcomes: JSON.stringify(["Yes", "No"]), clobTokenIds: JSON.stringify(["123", "124"]),
  outcomePrices: JSON.stringify(["0.50", "0.50"]), active: true, closed: false,
  restricted: false, acceptingOrders: true, enableOrderBook: true, negRisk: false, version: "v1",
};

const competitionNames = { PL: "Premier League", PD: "LaLiga", SA: "Serie A", CL: "UEFA Champions League" };
function match(id, competition, date, status = "SCHEDULED") {
  return {
    id, utcDate: `${date}T19:00:00Z`, status, lastUpdated: "2026-10-16T12:00:00Z",
    competition: { code: competition, name: competitionNames[competition] },
    homeTeam: { id: 101, name: "Arsenal" }, awayTeam: { id: 202, name: "Chelsea" },
    score: { fullTime: { home: status === "FINISHED" ? 2 : null, away: status === "FINISHED" ? 1 : null } },
  };
}
const history = (teamId) => Array.from({ length: 5 }, (_, index) => {
  const homeId = index % 2 === 0 ? teamId : 303;
  const awayId = index % 2 === 0 ? 303 : teamId;
  return {
    ...match(8000 + teamId * 10 + index, "PL", `2026-10-${String(10 - index).padStart(2, "0")}`, "FINISHED"),
    homeTeam: { id: homeId, name: homeId === teamId ? (teamId === 101 ? "Arsenal" : "Chelsea") : "Liverpool" },
    awayTeam: { id: awayId, name: awayId === teamId ? (teamId === 101 ? "Arsenal" : "Chelsea") : "Liverpool" },
  };
});

globalThis.fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  let body;
  if (url.hostname === "gamma-api.polymarket.com" && url.pathname === "/markets/1") {
    body = market;
  } else if (url.hostname === "clob.polymarket.com" && url.pathname === "/book" && ["123", "124", "999"].includes(url.searchParams.get("token_id") ?? "")) {
    const assetId = url.searchParams.get("token_id");
    body = {
      asset_id: assetId, market: conditionId,
      timestamp: assetId === "124" ? String(Math.floor(Date.now() / 1000) - 120) : String(Math.floor(Date.now() / 1000)),
      bids: [{ price: "0.49", size: "100" }], asks: [{ price: "0.50", size: "100" }],
      min_order_size: "5", tick_size: "0.01", neg_risk: false, version: "v1",
    };
  } else if (url.hostname === "clob.polymarket.com" && url.pathname === `/clob-markets/${conditionId}`) {
    body = { fd: { r: 0.05, e: 1 } };
  } else if (url.hostname === "api.football-data.org" && url.pathname.startsWith("/v4/competitions/")) {
    const league = url.pathname.split("/")[3];
    if (url.searchParams.get("dateFrom") === "2026-11-01") return new Response("provider unavailable", { status: 403 });
    body = { matches: [match(({ PL: 1001, PD: 2001, SA: 3001, CL: 4001 })[league], league, "2026-10-17")] };
  } else if (url.hostname === "api.football-data.org" && url.pathname === "/v4/matches/9999") {
    body = match(9999, "PL", "2026-10-20");
  } else if (url.hostname === "api.football-data.org" && url.pathname.startsWith("/v4/matches/")) {
    const id = Number(url.pathname.split("/").at(-1));
    const league = ({ 1001: "PL", 2001: "PD", 3001: "SA", 4001: "CL" })[id];
    body = match(id, league, "2026-10-17");
  } else if (url.hostname === "api.football-data.org" && url.pathname.startsWith("/v4/teams/")) {
    const teamId = Number(url.pathname.split("/")[3]);
    body = { matches: history(teamId).slice(0, url.searchParams.get("dateTo") === "2026-10-19" && teamId === 101 ? 4 : 5) };
  } else if (url.hostname === "www.espn.com" && url.pathname === "/espn/rss/soccer/news") {
    const publishedAt = new Date().toUTCString();
    body = `<?xml version="1.0"?><rss><channel><item><title>Arsenal confirms training update</title><link>https://www.espn.com/soccer/story/1</link><description>Arsenal update.</description><pubDate>${publishedAt}</pubDate></item><item><title>General football headline</title><link>https://www.espn.com/soccer/story/2</link><pubDate>${publishedAt}</pubDate></item></channel></rss>`;
    return new Response(body, { headers: { "content-type": "application/rss+xml" } });
  } else if (url.hostname === "data-api.polymarket.com" && url.pathname === "/v2/positions") {
    body = { data: [] };
  } else {
    return new Response(JSON.stringify({ error: "unexpected fixture request" }), {
      status: 404, headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
};
