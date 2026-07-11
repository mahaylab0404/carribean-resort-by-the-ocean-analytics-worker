const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const CORS_JSON = { ...CORS, "Content-Type": "application/json" };

const GOOGLE_PLACE_ID    = "ChIJTbXIUSOr2YgRikZNCumgfvg";
const TRIPADVISOR_LOC_ID = "595285";

// Only flag when a review explicitly complains about a phone/call problem
const PHONE_ISSUE_PATTERNS = [
  /no one (answered|picked up)/i,
  /couldn'?t (reach|get through|get anyone on the phone)/i,
  /never (answered|called (me )?back)/i,
  /didn'?t (answer|pick up|call (me )?back)/i,
  /on hold (for \d|forever|too long|a long time)/i,
  /hung up on (me|us)/i,
  /phone (kept ringing|just rang|went to voicemail|was never answered)/i,
  /called (multiple times|several times|again and again) (and no|but no|with no)/i,
  /no (callback|call back|response to my call|reply to my call)/i,
  /unanswered (call|phone)/i,
  /impossible to (reach|get through|contact) (by phone|on the phone|anyone)/i,
  /automated (system|voice|bot) (was |is )?(confusing|useless|unhelpful|broken|wrong)/i,
  /spoke to (a bot|an ai|a machine) (and|that|but) (it )?(couldn'?t|didn'?t|failed)/i,
  /ai (receptionist|bot|system) (was |is )?(wrong|unhelpful|confused|broken|failed)/i,
];

function phoneFlag(text) {
  if (!text) return 0;
  return PHONE_ISSUE_PATTERNS.some(p => p.test(text)) ? 1 : 0;
}

// Check admin secret header for protected endpoints
function isAuthorized(request, env) {
  const secret = env.ADMIN_SECRET;
  if (!secret) return true; // if no secret configured, allow (backward compat)
  return request.headers.get("X-Admin-Secret") === secret;
}

// ── AWS Signature V4 ────────────────────────────────
async function hmacSHA256(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

async function sha256hex(data) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function signBedrockRequest(method, url, body, accessKeyId, secretAccessKey, region) {
  const SERVICE = "bedrock";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);
  const parsedUrl = new URL(url);
  const host = parsedUrl.host;
  const path = parsedUrl.pathname;
  const bodyHash = await sha256hex(body);
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-date";
  const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, bodyHash].join("\n");
  const credentialScope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, await sha256hex(canonicalRequest)].join("\n");
  const kDate    = await hmacSHA256("AWS4" + secretAccessKey, dateStamp);
  const kRegion  = await hmacSHA256(kDate, region);
  const kService = await hmacSHA256(kRegion, SERVICE);
  const kSigning = await hmacSHA256(kService, "aws4_request");
  const signature = toHex(await hmacSHA256(kSigning, stringToSign));
  return {
    "Authorization": `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "Content-Type": "application/json",
    "X-Amz-Date": amzDate,
  };
}

// Generate suggestion via Claude Haiku on AWS Bedrock
async function generateSuggestion(env, reviewText, rating) {
  if (!reviewText || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return null;
  try {
    const region  = env.AWS_REGION || "us-east-1";
    const modelId = "anthropic.claude-3-haiku-20240307-v1:0";
    const url     = `https://bedrock-runtime.${region}.amazonaws.com/model/${modelId}/invoke`;
    const prompt  = `You are a hotel operations consultant. A guest left this ${rating}-star review for Caribbean Resort & Suite in Hollywood, FL:\n\n"${reviewText.slice(0, 600)}"\n\nWrite ONE specific, practical, actionable suggestion (2-3 sentences) for what hotel management should do to prevent this exact issue from recurring. Be direct and specific — no generic advice. Start with the concrete action.`;
    const body = JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
    });
    const headers = await signBedrockRequest("POST", url, body, env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, region);
    const res = await fetch(url, { method: "POST", headers, body });
    if (!res.ok) { console.error("Bedrock error:", res.status); return null; }
    const data = await res.json();
    return data?.content?.[0]?.text?.trim() ?? null;
  } catch (err) {
    console.error("generateSuggestion error:", err.message);
    return null;
  }
}

// ── ROUTER ──────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method === "POST" && url.pathname === "/") {
      return handleWebhook(request, env);
    }
    if (request.method === "GET" && url.pathname === "/") {
      return handleGetCalls(env);
    }
    if (request.method === "GET" && url.pathname === "/reviews") {
      return handleGetReviews(env);
    }

    // Protected admin endpoints
    if (request.method === "POST" && url.pathname === "/fetch-reviews") {
      if (!isAuthorized(request, env)) return new Response("Unauthorized", { status: 401, headers: CORS });
      return handleFetchReviews(env);
    }
    if (request.method === "POST" && url.pathname === "/fix-flags") {
      if (!isAuthorized(request, env)) return new Response("Unauthorized", { status: 401, headers: CORS });
      return handleFixFlags(env);
    }
    if (request.method === "POST" && url.pathname === "/fix-suggestions") {
      if (!isAuthorized(request, env)) return new Response("Unauthorized", { status: 401, headers: CORS });
      return handleFixSuggestions(env);
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchAndStoreReviews(env));
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
  // Guard against object values from ElevenLabs
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
    // Return 500 so ElevenLabs retries on genuine DB failures
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

// ── Get reviews ─────────────────────────────────────
async function handleGetReviews(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, source, author, rating, text, published_at, phone_flag, suggestion, fetched_at
       FROM hotel_reviews ORDER BY fetched_at DESC LIMIT 300`
    ).all();
    return new Response(JSON.stringify(results), { status: 200, headers: CORS_JSON });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_JSON });
  }
}

// ── Fix phone flags ─────────────────────────────────
async function handleFixFlags(env) {
  try {
    const { results } = await env.DB.prepare(`SELECT id, text FROM hotel_reviews`).all();
    // Batch updates using D1 batch API to avoid N sequential round-trips
    const stmts = results.map(r =>
      env.DB.prepare(`UPDATE hotel_reviews SET phone_flag = ? WHERE id = ?`).bind(phoneFlag(r.text), r.id)
    );
    if (stmts.length) await env.DB.batch(stmts);
    const flagged = results.filter(r => phoneFlag(r.text)).length;
    return new Response(JSON.stringify({ updated: results.length, flagged }), { status: 200, headers: CORS_JSON });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_JSON });
  }
}

// ── Fix suggestions ─────────────────────────────────
async function handleFixSuggestions(env) {
  try {
    // Process max 10 at a time to avoid Worker timeout
    const { results } = await env.DB.prepare(
      `SELECT id, text, rating FROM hotel_reviews WHERE suggestion IS NULL AND rating <= 3 LIMIT 10`
    ).all();

    let updated = 0;
    for (const r of results) {
      const suggestion = await generateSuggestion(env, r.text, r.rating);
      if (suggestion) {
        await env.DB.prepare(`UPDATE hotel_reviews SET suggestion = ? WHERE id = ?`).bind(suggestion, r.id).run();
        updated++;
      }
    }
    const remaining = results.length - updated;
    return new Response(JSON.stringify({ updated, remaining }), { status: 200, headers: CORS_JSON });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_JSON });
  }
}

// ── Manual fetch trigger ────────────────────────────
async function handleFetchReviews(env) {
  try {
    const count = await fetchAndStoreReviews(env);
    return new Response(JSON.stringify({ fetched: count }), { status: 200, headers: CORS_JSON });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_JSON });
  }
}

// ── Core SerpAPI fetch + D1 store ───────────────────
async function fetchAndStoreReviews(env) {
  const key = env.SERP_API_KEY;
  if (!key) throw new Error("SERP_API_KEY secret not configured");

  let totalStored = 0;

  // Google reviews
  try {
    const gRes = await fetch(
      `https://serpapi.com/search.json?engine=google_maps_reviews&place_id=${GOOGLE_PLACE_ID}&api_key=${key}&hl=en`
    );
    if (!gRes.ok) throw new Error(`SerpAPI Google error: ${gRes.status}`);
    const gData = await gRes.json();

    for (const r of (gData.reviews ?? [])) {
      const text   = r.snippet ?? r.text ?? null;
      const rating = r.rating ?? null;
      const author = r.user?.name ?? null;
      const date   = r.iso_date ?? null;
      // Skip if already stored (dedup by source+author+published_at)
      const exists = await env.DB.prepare(
        `SELECT id FROM hotel_reviews WHERE source = 'google' AND author = ? AND published_at = ? LIMIT 1`
      ).bind(author, date).first();
      if (exists) continue;

      // Store without suggestion — generate async via /fix-suggestions
      await env.DB.prepare(
        `INSERT INTO hotel_reviews (source, author, rating, text, published_at, phone_flag)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind("google", author, rating, text, date, phoneFlag(text)).run();
      totalStored++;
    }
  } catch (err) {
    console.error("Google reviews fetch error:", err.message);
  }

  // TripAdvisor reviews
  try {
    const tRes = await fetch(
      `https://serpapi.com/search.json?engine=tripadvisor_reviews&location_id=${TRIPADVISOR_LOC_ID}&api_key=${key}`
    );
    if (!tRes.ok) throw new Error(`SerpAPI TripAdvisor error: ${tRes.status}`);
    const tData = await tRes.json();

    for (const r of (tData.reviews ?? [])) {
      const text   = r.text ?? null;
      const rating = r.rating ?? null;
      const author = r.user?.username ?? null;
      const date   = r.travel_date ?? null;
      // Skip if already stored
      const exists = await env.DB.prepare(
        `SELECT id FROM hotel_reviews WHERE source = 'tripadvisor' AND author = ? AND published_at = ? LIMIT 1`
      ).bind(author, date).first();
      if (exists) continue;

      await env.DB.prepare(
        `INSERT INTO hotel_reviews (source, author, rating, text, published_at, phone_flag)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind("tripadvisor", author, rating, text, date, phoneFlag(text)).run();
      totalStored++;
    }
  } catch (err) {
    console.error("TripAdvisor reviews fetch error:", err.message);
  }

  return totalStored;
}
