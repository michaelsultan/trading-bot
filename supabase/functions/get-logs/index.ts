import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_REF = "rwfbleacxufaojkztxbj";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

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

  const [runsRes, decisionsRes, botStateRes] = await Promise.all([
    supabase.rpc("get_bot_run_logs", { limit_n: 50 }),
    supabase
      .from("trades")
      .select("created_at, action, symbol, quantity, reason, status")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("bot_runs")
      .select("is_running, started_at")
      .eq("id", 1)
      .single(),
  ]);

  return new Response(
    JSON.stringify({
      runs:      runsRes.data      ?? [],
      decisions: decisionsRes.data ?? [],
      bot_state: botStateRes.data  ?? { is_running: false, started_at: null },
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
