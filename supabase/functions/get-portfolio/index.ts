import { createClient } from "jsr:@supabase/supabase-js@2";

const ALPACA_BASE_URL = "https://paper-api.alpaca.markets/v2";

const alpacaHeaders = {
  "APCA-API-KEY-ID": Deno.env.get("ALPACA_API_KEY")!,
  "APCA-API-SECRET-KEY": Deno.env.get("ALPACA_SECRET_KEY")!,
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

const SUPABASE_REF = "rwfbleacxufaojkztxbj";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Vérifier que le JWT est bien émis par ce projet Supabase
  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const payload = JSON.parse(atob(token.split(".")[1]));
    if (payload.iss !== "supabase" || payload.ref !== SUPABASE_REF) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
    }
  } catch {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const [account, positions, clock, snapshotsRes, tradesRes, analysisRes, weeklyRes] = await Promise.all([
    fetch(`${ALPACA_BASE_URL}/account`,   { headers: alpacaHeaders }).then(r => r.json()).catch(() => null),
    fetch(`${ALPACA_BASE_URL}/positions`, { headers: alpacaHeaders }).then(r => r.json()).catch(() => null),
    fetch(`${ALPACA_BASE_URL}/clock`,     { headers: alpacaHeaders }).then(r => r.json()).catch(() => null),
    supabase.from("portfolio_snapshots").select("created_at, cash, equity").order("created_at", { ascending: true }).limit(200),
    supabase.from("trades").select("*").order("created_at", { ascending: false }).limit(40),
    supabase.from("bot_analyses").select("*").eq("type", "analysis").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("bot_analyses").select("*").eq("type", "weekly_summary").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  return new Response(
    JSON.stringify({
      account,
      positions,
      market_open:    clock?.is_open ?? false,
      snapshots:      snapshotsRes.data ?? [],
      trades:         tradesRes.data    ?? [],
      analysis:       analysisRes.data  ?? null,
      weekly_summary: weeklyRes.data    ?? null,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
