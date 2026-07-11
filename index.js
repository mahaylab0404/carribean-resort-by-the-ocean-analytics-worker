const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const GOOGLE_PLACE_ID     = "ChIJTbXIUSOr2YgRikZNCumgfvg";
const TRIPADVISOR_LOC_ID  = "595285";

// Phrases indicating a NEGATIVE phone/call experience (not just mentions of the word)
const PHONE_ISSUE_PATTERNS = [
  /no one (answered|picked up|was available)/i,
  /couldn'?t (reach|get through|get anyone)/i,
  /never (answered|called back|responded)/i,
  /didn'?t (answer|pick up|call back|respond)/i,
  /unanswered (call|phone)/i,
  /left (a message|voicemail|on hold)/i,
  /on hold (for|forever|too long)/i,
  /hung up on/i,
  /phone (issue|problem|trouble|complaint)/i,
  /hard to (reach|get|contact)/i,
  /impossible to (reach|get|contact)/i,
  /receptionist (was rude|ignored|unhelpful|didn'?t)/i,
  /front desk (was rude|ignored|unhelpful|never|didn'?t)/i,
  /called (multiple times|several times|again and again|back and forth)/i,
  /no (response|callback|reply) (to my|to our) (call|message|voicemail)/i,
  /phone (kept|always|just) (ringing|going to voicemail)/i,
  /ai (was unhelpful|couldn'?t help|didn'?t understand|failed|gave wrong)/i,
  /automated (system|voice|bot) (was|is) (confusing|useless|unhelpful|wrong)/i,
  /robot (couldn'?t|didn'?t|failed)/i,
  /spoke to (a bot|an ai|a machine) (and|that|who|but)/i,
];

function phoneFlag(text) {
  if (!text) return 0;
  return PHONE_ISSUE_PATTERNS.some(p => p.test(text)) ? 1 : 0;
}

// Generate a tailored suggestion using Cloudflare Workers AI
async function generateSuggestion(env, reviewText, rating) {
  if (!env.AI || !reviewText) return null;
  try {
    const prompt = `You are a hotel operations consultant. A guest left this ${rating}-star review for a hotel:

"${reviewText.slice(0, 600)}"

Write ONE specific, practical, actionable suggestion (2-3 sentences max) for what the hotel management should do to prevent this issue from happening again. Be direct and specific — no generic advice. Do not start with "I suggest" or "You should". Start with the action itself.`;

    const response = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 120,
    });
    return response?.response?.trim() ?? null;
  } catch {
    return null;
  }
}

export default {
  // ── HTTP handler ────────────────────────────────
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

    // GET /reviews  — return stored reviews
    if (request.method === "GET" && url.pathname === "/reviews") {
      return handleGetReviews(env);
    }

    // POST /fetch-reviews  — manually trigger a SerpAPI fetch
    if (request.method === "POST" && url.pathname === "/fetch-reviews") {
      return handleFetchReviews(env);
    }

    return new Response("Not found", { status: 404 });
  },

  // ── Cron handler (every Monday 9am UTC) ─────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchAndStoreReviews(env));
  },
};

// ── ElevenLabs webhook ──────────────────────────────
async function handleWebhook(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return new Response("Invalid JSON", { status: 400 }); }

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
  const sentiment     = analysis.sentiment_analysis ?? null;

  try {
    await env.DB.prepare(
      `INSERT INTO hotel_calls
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
    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
}

// ── Get reviews ─────────────────────────────────────
async function handleGetReviews(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, source, author, rating, text, published_at, phone_flag, suggestion, fetched_at
       FROM hotel_reviews ORDER BY fetched_at DESC LIMIT 300`
    ).all();
    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
}

// ── Manual fetch trigger ────────────────────────────
async function handleFetchReviews(env) {
  try {
    const count = await fetchAndStoreReviews(env);
    return new Response(JSON.stringify({ fetched: count }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
}

// ── Core SerpAPI fetch + D1 store ───────────────────
async function fetchAndStoreReviews(env) {
  const key = env.SERP_API_KEY;
  if (!key) throw new Error("SERP_API_KEY secret not configured");

  let totalStored = 0;

  // Google reviews
  try {
    const gUrl = `https://serpapi.com/search.json?engine=google_maps_reviews&place_id=${GOOGLE_PLACE_ID}&api_key=${key}&hl=en`;
    const gRes = await fetch(gUrl);
    const gData = await gRes.json();
    const reviews = gData.reviews ?? [];

    for (const r of reviews) {
      const text = r.snippet ?? r.text ?? null;
      const rating = r.rating ?? null;
      const flag = phoneFlag(text);
      const suggestion = (rating && rating <= 3) ? await generateSuggestion(env, text, rating) : null;
      await env.DB.prepare(
        `INSERT INTO hotel_reviews (source, author, rating, text, published_at, phone_flag, suggestion)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind("google", r.user?.name ?? null, rating, text, r.iso_date ?? null, flag, suggestion).run();
      totalStored++;
    }
  } catch (err) {
    console.error("Google reviews fetch error:", err.message);
  }

  // TripAdvisor reviews
  try {
    const tUrl = `https://serpapi.com/search.json?engine=tripadvisor_reviews&location_id=${TRIPADVISOR_LOC_ID}&api_key=${key}`;
    const tRes = await fetch(tUrl);
    const tData = await tRes.json();
    const reviews = tData.reviews ?? [];

    for (const r of reviews) {
      const text = r.text ?? null;
      const rating = r.rating ?? null;
      const flag = phoneFlag(text);
      const suggestion = (rating && rating <= 3) ? await generateSuggestion(env, text, rating) : null;
      await env.DB.prepare(
        `INSERT INTO hotel_reviews (source, author, rating, text, published_at, phone_flag, suggestion)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind("tripadvisor", r.user?.username ?? null, rating, text, r.travel_date ?? null, flag, suggestion).run();
      totalStored++;
    }
  } catch (err) {
    console.error("TripAdvisor reviews fetch error:", err.message);
  }

  return totalStored;
}
