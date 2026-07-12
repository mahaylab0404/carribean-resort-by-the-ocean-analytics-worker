const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const CORS_JSON = { ...CORS, "Content-Type": "application/json" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // POST /  — ElevenLabs webhook
    if (request.method === "POST" && url.pathname === "/") {
      return handleWebhook(request, env);
    }

    // GET /  — return call log
    if (request.method === "GET" && url.pathname === "/") {
      return handleGetCalls(env);
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};

// ── ElevenLabs webhook ──────────────────────────────
async function handleWebhook(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return new Response("Invalid JSON", { status: 400, headers: CORS }); }

  const conversationId   = body.conversation_id ?? null;
  const status           = body.status ?? null;
  const callerPhone      = body.metadata?.caller_phone_number ?? null;
  const duration         = body.call_duration_secs ?? null;
  const hasAudio         = body.has_audio         != null ? (body.has_audio ? 1 : 0) : null;
  const hasUserAudio     = body.has_user_audio     != null ? (body.has_user_audio ? 1 : 0) : null;
  const hasResponseAudio = body.has_response_audio != null ? (body.has_response_audio ? 1 : 0) : null;

  let transcript = null;
  if (Array.isArray(body.transcript)) {
    transcript = body.transcript.map(t => `${t.role}: ${t.message}`).join("\n");
  } else if (typeof body.transcript === "string") {
    transcript = body.transcript;
  }

  const analysis      = body.analysis ?? {};
  const dataCol       = analysis.data_collection ?? {};
  const issueCategory = dataCol.issue_category ?? null;
  const callerName    = dataCol.full_name ?? null;
  const sentimentRaw  = analysis.sentiment_analysis ?? null;
  const sentiment     = typeof sentimentRaw === "string" ? sentimentRaw : null;

  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO hotel_calls
        (conversation_id, status, caller_phone, transcript,
         duration, has_audio, has_user_audio, has_response_audio,
         issue_category, caller_name, sentiment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      conversationId, status, callerPhone, transcript,
      duration, hasAudio, hasUserAudio, hasResponseAudio,
      issueCategory, callerName, sentiment
    ).run();
  } catch (err) {
    console.error("D1 insert error:", err.message);
    return new Response("DB error", { status: 500, headers: CORS });
  }

  return new Response("OK", { status: 200, headers: CORS });
}

// ── Get call log ────────────────────────────────────
async function handleGetCalls(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, conversation_id, status, caller_phone, transcript,
              duration, has_audio, has_user_audio, has_response_audio,
              issue_category, caller_name, sentiment, created_at
       FROM hotel_calls ORDER BY created_at DESC LIMIT 500`
    ).all();
    return new Response(JSON.stringify(results), { status: 200, headers: CORS_JSON });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_JSON });
  }
}
