var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
function base64ToUint8(b64) {
  const bin = atob(b64.replace(/^data:image\/\w+;base64,/, ""));
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}
__name(base64ToUint8, "base64ToUint8");
function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
__name(cosineSimilarity, "cosineSimilarity");
var src_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/photos/upload" && request.method === "POST") return handlePhotoUpload(request, env);
      if (path === "/api/photos" && request.method === "GET") return handleListPhotos(request, env);
      if (path.startsWith("/api/photos/") && request.method === "GET") {
        const key = path.slice("/api/photos/".length);
        if (key) return handleServePhoto(key, env);
        return new Response(JSON.stringify({ error: "Missing key" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
      }
      if (request.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: { ...CORS, "Content-Type": "application/json" } });
      if (path === "/api/scan") return handleVisionScan(request, env);
      if (path === "/api/match") return handleVisionMatch(request, env);
      if (path === "/api/history") return handleHistory(request, env);
      if (path === "/api/search") return handleVectorSearch(request, env);
      if (path === "/api/chat") return handleChat(request, env);
      return new Response(JSON.stringify({ error: "Unknown route" }), { status: 404, headers: { ...CORS, "Content-Type": "application/json" } });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
    }
  }
};
async function handleVisionScan(request, env) {
  const { image, userId = "anonymous", roomName = "Unknown", location = "Scanned" } = await request.json();
  if (!image) return new Response(JSON.stringify({ error: "Missing image" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  const imageBytes = base64ToUint8(image);
  const prompt = `You are an item identification assistant. Analyze this image and identify the single most prominent object. Return ONLY a valid JSON object with these exact keys:
  - "itemName": short descriptive name (e.g. "Singapore Passport", "Car Key", "Black Leather Wallet")
  - "confidence": "high", "medium", or "low"
  - "distinctFeatures": array of 2-4 visible characteristics (e.g. ["Red cover", "Gold coat of arms", "White text"])
  - "suggestedCategory": one of: Documents, Keys, Electronics, Valuables, Warranties, Other
  - "description": one short sentence describing where someone might keep this item

  Do NOT include any text outside the JSON object.`;
  const aiResult = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
    image: [...imageBytes],
    prompt,
    max_tokens: 300
  });
  const raw = typeof aiResult === "object" ? aiResult.response ?? JSON.stringify(aiResult) : aiResult;
  const jsonMatch = String(raw).match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return new Response(JSON.stringify({
      itemName: "Unknown Item",
      confidence: "low",
      distinctFeatures: [],
      suggestedCategory: "Other",
      description: "AI could not identify this item"
    }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }
  const parsed = JSON.parse(jsonMatch[0]);
  const scanEntry = {
    ...parsed,
    imagePreview: image.slice(0, 100) + "...",
    // store thumbnail prefix only
    roomName,
    location,
    userId,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
  const scanId = crypto.randomUUID();
  await env.SCAN_KV.put(`scan:${scanId}`, JSON.stringify(scanEntry), { expirationTtl: 604800 });
  const stmt = env.SCAN_DB.prepare(`
    INSERT INTO scans (id, user_id, item_name, confidence, distinct_features, suggested_category, description, room_name, location, image_b64, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
  `);
  await stmt.bind(
    scanId,
    userId,
    parsed.itemName,
    parsed.confidence,
    JSON.stringify(parsed.distinctFeatures),
    parsed.suggestedCategory,
    parsed.description,
    roomName,
    location,
    image,
    (/* @__PURE__ */ new Date()).toISOString()
  ).run();
  return new Response(JSON.stringify({ scanId, ...parsed }), {
    headers: { ...CORS, "Content-Type": "application/json" }
  });
}
__name(handleVisionScan, "handleVisionScan");
async function handleVisionMatch(request, env) {
  const { image, userId = "anonymous" } = await request.json();
  if (!image) return new Response(JSON.stringify({ error: "Missing image" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  const { results } = await env.SCAN_DB.prepare(
    "SELECT id, item_name, image_b64, room_name, location, created_at FROM scans WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 20"
  ).bind(userId).all();
  if (!results || results.length === 0) {
    return new Response(JSON.stringify({ match: null, message: "No previous scans to compare against" }), {
      headers: { ...CORS, "Content-Type": "application/json" }
    });
  }
  const imageBytes = base64ToUint8(image);
  const libraryList = results.map((r) => `- "${r.item_name}" (scanned ${r.created_at} in ${r.room_name})`).join("\n");
  const matchPrompt = `Here is a newly photographed item. The user has previously scanned these items:
${libraryList}

Does this new photo match any of the previously scanned items? Return ONLY JSON: {"match": true|false, "matchedItem": "<name or null>", "scanId": "<id or null>", "confidence": "high|medium|low"}`;
  const aiResult = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
    image: [...imageBytes],
    prompt: matchPrompt,
    max_tokens: 150
  });
  const raw = typeof aiResult === "object" ? aiResult.response ?? JSON.stringify(aiResult) : aiResult;
  const jsonMatch = String(raw).match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    const matchData = JSON.parse(jsonMatch[0]);
    return new Response(JSON.stringify(matchData), { headers: { ...CORS, "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ match: false, matchedItem: null, scanId: null, confidence: "low" }), {
    headers: { ...CORS, "Content-Type": "application/json" }
  });
}
__name(handleVisionMatch, "handleVisionMatch");
async function handleHistory(request, env) {
  const { userId = "anonymous" } = await request.json();
  const { results } = await env.SCAN_DB.prepare(
    "SELECT id, item_name, confidence, distinct_features, suggested_category, description, room_name, location, created_at FROM scans WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 50"
  ).bind(userId).all();
  return new Response(JSON.stringify({ scans: results ?? [] }), {
    headers: { ...CORS, "Content-Type": "application/json" }
  });
}
__name(handleHistory, "handleHistory");
async function handleVectorSearch(request, env) {
  const { query, items, rooms } = await request.json();
  if (!query || !items?.length) {
    return new Response(JSON.stringify({ results: [] }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }
  const passages = items.map((item) => `${item.name} ${item.location} ${item.category} ${item.name}`);
  const embRes = await env.AI.run("@cf/baai/bge-small-en-v1.5", { text: [...passages, query] });
  const itemVectors = embRes.data.slice(0, passages.length);
  const queryVector = embRes.data[passages.length];
  if (!queryVector || itemVectors.length === 0) {
    return new Response(JSON.stringify({ results: [] }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }
  const scored = itemVectors.map((vec, idx) => ({ idx, score: cosineSimilarity(queryVector, vec) }));
  const roomMap = new Map(rooms.map((r) => [r.id, r]));
  const results = scored.sort((a, b) => b.score - a.score).filter((s) => s.score >= 0.3).slice(0, 5).map((s) => {
    const item = items[s.idx];
    const room = roomMap.get(item.roomId);
    let bestZone = null;
    if (room) {
      let bestDist = Infinity;
      for (const z of room.zones) {
        const d = Math.sqrt((item.zoneX - z.x) ** 2 + (item.zoneY - z.y) ** 2);
        if (d < bestDist) {
          bestDist = d;
          bestZone = { id: z.id, label: z.label, x: z.x, y: z.y };
        }
      }
    }
    return { itemId: item.id, itemName: item.name, location: item.location, category: item.category, roomId: item.roomId, roomName: room?.name ?? "Unknown", zone: bestZone, score: Math.round(s.score * 1e3) / 1e3 };
  });
  return new Response(JSON.stringify({ results }), { headers: { ...CORS, "Content-Type": "application/json" } });
}
__name(handleVectorSearch, "handleVectorSearch");
async function handleChat(request, env) {
  const { message, items = [], rooms = [], history = [] } = await request.json();
  if (!message) {
    return new Response(JSON.stringify({ error: "Missing message" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  const roomMap = new Map(rooms.map((r) => [r.id, r]));
  const inventoryLines = items.map((item) => {
    const room = roomMap.get(item.roomId);
    return `- ${item.name} (${item.category}) \u2014 ${item.location}, in ${room?.name ?? "Unknown"}`;
  });
  const inventoryContext = inventoryLines.length > 0 ? `

The user's tracked inventory:
${inventoryLines.join("\n")}` : "\n\nThe user has no tracked items yet.";
  const historyBlock = history.map(
    (h) => h.role === "user" ? `User: ${h.content}` : `Assistant: ${h.content}`
  ).join("\n");
  const systemPrompt = `You are a helpful lost-item assistant. Your job is to help the user find items they've misplaced by searching their inventory.

Rules:
1. Always be helpful, concise, and friendly.
2. If the user asks about a specific item and it's in their inventory, tell them exactly where it is (room + location).
3. If the item isn't in their inventory, suggest where they might typically keep it based on its category.
4. If the user asks about items of a certain category (e.g. "Where are my documents?"), list all matching items and their locations.
5. Keep responses short \u2014 2-4 sentences max.
6. When you mention a specific item from the inventory, include its UUID in brackets like [id:uuid-here] so the app can highlight it.${inventoryContext}`;
  const fullPrompt = `${systemPrompt}

${historyBlock}
User: ${message}
Assistant:`;
  const aiResult = await env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
    prompt: fullPrompt,
    max_tokens: 500
  });
  const raw = typeof aiResult === "object" ? aiResult.response ?? JSON.stringify(aiResult) : aiResult;
  const reply = String(raw).trim();
  const idRegex = /\[id:([^\]]+)\]/g;
  const suggestedItemIds = [];
  let idMatch;
  while ((idMatch = idRegex.exec(reply)) !== null) {
    suggestedItemIds.push(idMatch[1]);
  }
  const cleanReply = reply.replace(/\[id:[^\]]+\]/g, "").trim();
  return new Response(JSON.stringify({ reply: cleanReply, suggestedItemIds }), {
    headers: { ...CORS, "Content-Type": "application/json" }
  });
}
__name(handleChat, "handleChat");
async function handlePhotoUpload(request, env) {
  const form = await request.formData();
  const file = form.get("image");
  if (!file) {
    return new Response(JSON.stringify({ error: "Missing image file" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  const userId = form.get("userId") || "anonymous";
  const itemName = form.get("itemName") || "Unknown Item";
  const category = form.get("category") || "Other";
  const roomLocation = form.get("roomLocation") || "Scanned";
  const ext = file.name.match(/\.(\w+)$/)?.[1] || "jpg";
  const id = crypto.randomUUID();
  const r2Key = `${userId}/${Date.now()}_${id.slice(0, 8)}.${ext}`;
  const buffer = await file.arrayBuffer();
  await env.BUCKET.put(r2Key, buffer, {
    httpMetadata: { contentType: file.type || "image/jpeg" },
    customMetadata: { itemName, category, roomLocation }
  });
  await env.SCAN_DB.prepare(
    `INSERT INTO photos (id, user_id, r2_key, item_name, category, room_location, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).bind(id, userId, r2Key, itemName, category, roomLocation, (/* @__PURE__ */ new Date()).toISOString()).run();
  return new Response(JSON.stringify({ id, r2Key, itemName, category }), {
    headers: { ...CORS, "Content-Type": "application/json" }
  });
}
__name(handlePhotoUpload, "handlePhotoUpload");
async function handleListPhotos(request, env) {
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId") || "anonymous";
  const { results } = await env.SCAN_DB.prepare(
    "SELECT id, r2_key, item_name, category, room_location, created_at FROM photos WHERE user_id = ?1 ORDER BY created_at DESC"
  ).bind(userId).all();
  const categorized = {};
  for (const row of results) {
    const cat = row.category || "Other";
    if (!categorized[cat]) categorized[cat] = [];
    categorized[cat].push(row);
  }
  return new Response(JSON.stringify({ categories: categorized, total: results?.length ?? 0 }), {
    headers: { ...CORS, "Content-Type": "application/json" }
  });
}
__name(handleListPhotos, "handleListPhotos");
async function handleServePhoto(key, env) {
  const object = await env.BUCKET.get(key);
  if (!object) {
    return new Response(JSON.stringify({ error: "Photo not found" }), { status: 404, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  const headers = {
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Type": object.httpMetadata?.contentType || "image/jpeg",
    "ETag": object.httpEtag || ""
  };
  return new Response(object.body, { headers: { ...CORS, ...headers } });
}
__name(handleServePhoto, "handleServePhoto");

// ../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-TCnZ9A/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-TCnZ9A/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
