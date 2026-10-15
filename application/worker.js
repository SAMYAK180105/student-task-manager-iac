/**
 * Student Task Manager - Cloudflare Worker
 *
 * One Worker does two jobs:
 *   1. Serves the frontend (index.html, style.css, script.js).
 *   2. Provides the REST API under /api/* and stores data in Workers KV.
 *
 * The line below is replaced by build.js with the real frontend files,
 * so the deployed Worker is a single self-contained file (dist/worker.js).
 */
const ASSETS = /*__ASSETS__*/ {};

const PRIORITIES = ["Low", "Medium", "High"];
const STATUSES = ["Pending", "In Progress", "Completed"];

// KV storage layout: one key per task ("task:<id>") plus one index key
// ("index") that holds a JSON array of task IDs.
const TASK_PREFIX = "task:";
const INDEX_KEY = "index";

// A Worker on the free plan may make only a limited number of subrequests per
// request (KV reads count). Capping the number of tasks keeps GET /api/tasks safe.
const MAX_TASKS = 40;
const MAX_BODY_BYTES = 10 * 1024;
const INDEX_RETRIES = 3;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const STATIC_ROUTES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/script.js": ["script.js", "text/javascript; charset=utf-8"],
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
    "frame-ancestors 'none'",
};

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// ---------- small helpers ----------

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonBody(request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new HttpError(413, "Request body is too large");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Validates task input. When `partial` is true (PUT), only the fields that are
 * present are checked. Returns the cleaned values or throws a 400 error.
 */
function validateTaskInput(input, partial) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  const errors = [];
  const value = {};

  if (!partial || "title" in input) {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (title.length === 0) errors.push("title is required and must be a non-empty string");
    else if (title.length > 120) errors.push("title must be 120 characters or fewer");
    else value.title = title;
  }
  if ("priority" in input) {
    if (PRIORITIES.includes(input.priority)) value.priority = input.priority;
    else errors.push(`priority must be one of: ${PRIORITIES.join(", ")}`);
  }
  if ("status" in input) {
    if (STATUSES.includes(input.status)) value.status = input.status;
    else errors.push(`status must be one of: ${STATUSES.join(", ")}`);
  }
  if ("category" in input) {
    if (input.category === null || input.category === "") value.category = "";
    else if (typeof input.category === "string" && input.category.trim().length <= 40) {
      value.category = input.category.trim();
    } else errors.push("category must be a string of 40 characters or fewer");
  }
  if ("deadline" in input) {
    if (input.deadline === null || input.deadline === "") value.deadline = null;
    else if (isValidDate(input.deadline)) value.deadline = input.deadline;
    else errors.push("deadline must be a valid date in YYYY-MM-DD format");
  }

  if (errors.length > 0) throw new HttpError(400, "Validation failed", errors);
  if (partial && Object.keys(value).length === 0) {
    throw new HttpError(400, "Provide at least one of: title, priority, status, category, deadline");
  }
  return value;
}

// ---------- KV storage layer ----------
// KV is eventually consistent and has no transactions. The index update below is a
// read-modify-write, so two simultaneous requests could overwrite each other.
// We reduce the risk (write the task first, verify the index, retry) and provide a
// repair path (GET /api/tasks?repair=true) that rebuilds the index from the task keys.

async function readIndex(kv) {
  try {
    const ids = await kv.get(INDEX_KEY, "json");
    return Array.isArray(ids) ? ids : null;
  } catch {
    return null;
  }
}

async function addToIndex(kv, id) {
  for (let attempt = 0; attempt < INDEX_RETRIES; attempt++) {
    const ids = (await readIndex(kv)) ?? [];
    if (!ids.includes(id)) {
      ids.push(id);
      await kv.put(INDEX_KEY, JSON.stringify(ids));
    }
    const check = await readIndex(kv);
    if (check && check.includes(id)) return true;
    await sleep(25 * (attempt + 1) + Math.random() * 25);
  }
  console.warn(`Index update for ${id} could not be confirmed; run GET /api/tasks?repair=true`);
  return false;
}

async function removeFromIndex(kv, id) {
  for (let attempt = 0; attempt < INDEX_RETRIES; attempt++) {
    const ids = (await readIndex(kv)) ?? [];
    if (ids.includes(id)) {
      await kv.put(INDEX_KEY, JSON.stringify(ids.filter((x) => x !== id)));
    }
    const check = await readIndex(kv);
    if (check && !check.includes(id)) return true;
    await sleep(25 * (attempt + 1) + Math.random() * 25);
  }
  return false; // Harmless: readers skip IDs whose task key no longer exists.
}

async function listAllTaskIds(kv) {
  const ids = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: TASK_PREFIX, cursor });
    for (const key of page.keys) ids.push(key.name.slice(TASK_PREFIX.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return ids;
}

const getTask = (kv, id) => kv.get(TASK_PREFIX + id, "json");

async function loadTasks(kv, repair) {
  let ids = await readIndex(kv);
  const rebuild = repair || ids === null;
  if (rebuild) {
    ids = [...new Set([...(ids ?? []), ...(await listAllTaskIds(kv))])];
  }
  const found = await Promise.all(ids.slice(0, MAX_TASKS).map((id) => getTask(kv, id)));
  const tasks = found.filter(Boolean);
  if (rebuild) await kv.put(INDEX_KEY, JSON.stringify(tasks.map((t) => t.id)));
  tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return tasks;
}

// ---------- API handlers ----------

async function handleHealth(env) {
  const time = new Date().toISOString();
  if (!env.TASKS_KV) {
    return json({ status: "degraded", kvBound: false, kvReachable: false, time }, 503);
  }
  try {
    await env.TASKS_KV.get(INDEX_KEY);
    return json({ status: "ok", kvBound: true, kvReachable: true, time });
  } catch {
    return json({ status: "degraded", kvBound: true, kvReachable: false, time }, 503);
  }
}

async function createTask(request, kv) {
  const input = validateTaskInput(await readJsonBody(request), false);
  const existing = (await readIndex(kv)) ?? [];
  if (existing.length >= MAX_TASKS) {
    throw new HttpError(409, `Task limit reached (${MAX_TASKS}). Delete a task first.`);
  }
  const now = new Date().toISOString();
  const task = {
    id: crypto.randomUUID(),
    title: input.title,
    priority: input.priority ?? "Medium",
    status: input.status ?? "Pending",
    category: input.category ?? "",
    deadline: input.deadline ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await kv.put(TASK_PREFIX + task.id, JSON.stringify(task)); // 1) save the task
  await addToIndex(kv, task.id); // 2) then list it in the index
  return json({ data: task }, 201);
}

async function updateTask(request, kv, id) {
  const existing = await getTask(kv, id);
  if (!existing) throw new HttpError(404, "Task not found");
  const changes = validateTaskInput(await readJsonBody(request), true);
  const task = { ...existing, ...changes, id: existing.id, createdAt: existing.createdAt };
  task.updatedAt = new Date().toISOString();
  await kv.put(TASK_PREFIX + id, JSON.stringify(task));
  return json({ data: task });
}

async function deleteTask(kv, id) {
  const existing = await getTask(kv, id);
  if (!existing) throw new HttpError(404, "Task not found");
  await kv.delete(TASK_PREFIX + id); // 1) remove the task
  await removeFromIndex(kv, id); // 2) then remove it from the index
  return json({ data: { id } });
}

function methodNotAllowed(allowed) {
  return json({ error: { message: "Method not allowed" } }, 405, { Allow: allowed.join(", ") });
}

async function handleApi(request, env, path, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (path === "/api/health") {
    if (request.method !== "GET") return methodNotAllowed(["GET", "OPTIONS"]);
    return handleHealth(env);
  }

  const isCollection = path === "/api/tasks";
  const itemMatch = path.match(/^\/api\/tasks\/([A-Za-z0-9-]{1,64})$/);
  if (!isCollection && !itemMatch) throw new HttpError(404, "Endpoint not found");

  const kv = env.TASKS_KV;
  if (!kv) throw new HttpError(503, "KV namespace binding TASKS_KV is missing");

  if (isCollection) {
    if (request.method === "GET") {
      const tasks = await loadTasks(kv, url.searchParams.get("repair") === "true");
      return json({ data: tasks, count: tasks.length });
    }
    if (request.method === "POST") return createTask(request, kv);
    return methodNotAllowed(["GET", "POST", "OPTIONS"]);
  }

  const id = itemMatch[1];
  if (request.method === "GET") {
    const task = await getTask(kv, id);
    if (!task) throw new HttpError(404, "Task not found");
    return json({ data: task });
  }
  if (request.method === "PUT") return updateTask(request, kv, id);
  if (request.method === "DELETE") return deleteTask(kv, id);
  return methodNotAllowed(["GET", "PUT", "DELETE", "OPTIONS"]);
}

function serveStatic(request, path) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const route = STATIC_ROUTES[path];
  const body = route ? ASSETS[route[0]] : undefined;
  if (body === undefined) {
    return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
  }
  return new Response(body, {
    headers: { "Content-Type": route[1], "Cache-Control": "no-cache", ...SECURITY_HEADERS },
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (path === "/api" || path.startsWith("/api/")) {
        return await handleApi(request, env, path, url);
      }
      return serveStatic(request, path);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: { message: err.message, details: err.details } }, err.status);
      }
      console.error("Unhandled error:", err);
      return json({ error: { message: "Internal server error" } }, 500);
    }
  },
};
