const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const GOOGLE_PLACE_ID     = "ChIJTbXIUSOr2YgRikZNCumgfvg";
const TRIPADVISOR_LOC_ID  = "595285";

// Only flag when a review explicitly complains about a phone/call problem
const PHONE_ISSUE_PATTERNS = [
  /no one (answered|picked up)/i,
  /couldn'?t (reach|get through|get anyone on the phone)/i,
  /never (answered|called (me )?back)/i,
  /didn'?t (answer|pick up|call (me )?back)/i,
  /on hold (for \d|forever|too long|a long time)/i,
  /hung up on (me|us)/i,
  /phone (kept ringing|just rang|went to voicemail|was never answered)/i,
  /called (multiple times|several times|again and again|back and forth) (and no|but no|with no)/i,
  /no (callback|call back|response to my call|reply to my call|answer)/i,
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

// ── AWS Signature V4 helpers (Web Crypto API) ───────
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

  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    "Authorization": authHeader,
    "Content-Type": "application/json",
    "X-Amz-Date": amzDate,
  };
}

// Generate a tailored suggestion using Claude via AWS Bedrock
async function generateSuggestion(env, reviewText, rating) {
  if (!reviewText || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return null;
  try {
    const region = env.AWS_REGION || "us-east-1";
    const modelId = "anthropic.claude-3-haiku-20240307-v1:0";
    const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${modelId}/invoke`;

    const prompt = `You are a hotel operations consultant. A guest left this ${rating}-star review for Caribbean Resort & Suite in Hollywood, FL:

"${reviewText.slice(0, 600)}"

Write ONE specific, practical, actionable suggestion (2-3 sentences) for what hotel management should do to prevent this exact issue from recurring. Be direct and specific to this review — no generic advice. Do not start with "I suggest" or "You should". Start with the concrete action.`;

    const body = JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
    });

    const headers = await signBedrockRequest(
      "POST", url, body,
      env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, region
    );

    const res = await fetch(url, { method: "POST", headers, body });
    if (!res.ok) {
      console.error("Bedrock error:", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    return data?.content?.[0]?.text?.trim() ?? null;
  } catch (err) {
    console.error("generateSuggestion error:", err.message);
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

    // POST /fix-flags  — re-evaluate phone flags on all existing reviews
    if (request.method === "POST" && url.pathname === "/fix-flags") {
      return handleFixFlags(env);
    }

    // POST /fix-suggestions  — generate missing suggestions for existing reviews
    if (request.method === "POST" && url.pathname === "/fix-suggestions") {
      return handleFixSuggestions(env);
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

// ── Fix phone flags on existing reviews ────────────
async function handleFixFlags(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, text FROM hotel_reviews`
    ).all();

    let updated = 0;
    for (const r of results) {
      const flag = phoneFlag(r.text);
      await env.DB.prepare(
        `UPDATE hotel_reviews SET phone_flag = ? WHERE id = ?`
      ).bind(flag, r.id).run();
      updated++;
    }

    return new Response(JSON.stringify({ updated, flagged: results.filter(r => phoneFlag(r.text)).length }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
}

// ── Generate missing suggestions for existing reviews ──
async function handleFixSuggestions(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, text, rating FROM hotel_reviews WHERE suggestion IS NULL AND rating <= 3`
    ).all();

    let updated = 0;
    for (const r of results) {
      const suggestion = await generateSuggestion(env, r.text, r.rating);
      if (suggestion) {
        await env.DB.prepare(
          `UPDATE hotel_reviews SET suggestion = ? WHERE id = ?`
        ).bind(suggestion, r.id).run();
        updated++;
      }
    }

    return new Response(JSON.stringify({ updated }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
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
