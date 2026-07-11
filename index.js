const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "POST") {
      return handleWebhook(request, env);
    }

    if (request.method === "GET") {
      return handleGetCalls(env);
    }

    return new Response("Method not allowed", { status: 405 });
  },
};

async function handleWebhook(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // --- Core Routing ---
  const conversationId = body.conversation_id ?? null;
  const status = body.status ?? null;

  // Telnyx phone number lives in metadata
  const callerPhone = body.metadata?.caller_phone_number ?? null;

  // Flatten transcript array into readable string
  let transcript = null;
  if (Array.isArray(body.transcript)) {
    transcript = body.transcript
      .map((t) => `${t.role}: ${t.message}`)
      .join("\n");
  } else if (typeof body.transcript === "string") {
    transcript = body.transcript;
  }

  // --- Dashboard Metrics ---
  const duration = body.call_duration_secs ?? null;
  const hasAudio = body.has_audio != null ? (body.has_audio ? 1 : 0) : null;
  const hasUserAudio = body.has_user_audio != null ? (body.has_user_audio ? 1 : 0) : null;
  const hasResponseAudio = body.has_response_audio != null ? (body.has_response_audio ? 1 : 0) : null;

  // --- ElevenLabs Native Analysis ---
  const analysis = body.analysis ?? {};
  const dataCollection = analysis.data_collection ?? {};
  const issueCategory = dataCollection.issue_category ?? null;
  const callerName = dataCollection.full_name ?? null;
  const sentiment = analysis.sentiment_analysis ?? null;

  try {
    await env.DB.prepare(
      `INSERT INTO hotel_calls (
        conversation_id, status, caller_phone, transcript,
        duration, has_audio, has_user_audio, has_response_audio,
        issue_category, caller_name, sentiment
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        conversationId, status, callerPhone, transcript,
        duration, hasAudio, hasUserAudio, hasResponseAudio,
        issueCategory, callerName, sentiment
      )
      .run();
  } catch (err) {
    console.error("D1 insert error:", err.message);
    // Always return 200 so ElevenLabs does not keep retrying
    return new Response("Stored with error", {
      status: 200,
      headers: CORS_HEADERS,
    });
  }

  return new Response("OK", { status: 200, headers: CORS_HEADERS });
}

async function handleGetCalls(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT
         id, conversation_id, status, caller_phone, transcript,
         duration, has_audio, has_user_audio, has_response_audio,
         issue_category, caller_name, sentiment, created_at
       FROM hotel_calls
       ORDER BY created_at DESC
       LIMIT 500`
    ).all();

    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("D1 query error:", err.message);
    return new Response(JSON.stringify({ error: "DB query failed" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
}
