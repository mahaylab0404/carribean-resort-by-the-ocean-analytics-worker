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

  const conversationId = body.conversation_id ?? null;
  const duration = body.call_duration_secs ?? null;
  const status = body.status ?? null;

  // ElevenLabs sends transcript as an array of { role, message } objects
  let transcript = null;
  if (Array.isArray(body.transcript)) {
    transcript = body.transcript
      .map((t) => `${t.role}: ${t.message}`)
      .join("\n");
  } else if (typeof body.transcript === "string") {
    transcript = body.transcript;
  }

  try {
    await env.DB.prepare(
      `INSERT INTO hotel_calls (conversation_id, duration, status, transcript)
       VALUES (?, ?, ?, ?)`
    )
      .bind(conversationId, duration, status, transcript)
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
      `SELECT id, conversation_id, duration, status, transcript, created_at
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
