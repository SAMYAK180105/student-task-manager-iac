// Run with: npm test   (builds dist/worker.js first, then runs these tests)
// The tests use a tiny in-memory fake of Workers KV, so no Cloudflare account is needed.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../dist/worker.js";

class MemoryKV {
  constructor() {
    this.map = new Map();
  }
  async get(key, type) {
    const value = this.map.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) {
    this.map.set(key, String(value));
  }
  async delete(key) {
    this.map.delete(key);
  }
  async list({ prefix = "" } = {}) {
    const keys = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
    return { keys, list_complete: true };
  }
}

let env;
beforeEach(() => {
  env = { TASKS_KV: new MemoryKV() };
});

async function call(method, path, body, rawBody) {
  const init = { method, headers: { "Content-Type": "application/json" } };
  if (rawBody !== undefined) init.body = rawBody;
  else if (body !== undefined) init.body = JSON.stringify(body);
  const response = await worker.fetch(new Request(`https://example.test${path}`, init), env);
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON (static file) */
  }
  return { status: response.status, headers: response.headers, data, text };
}

const sample = { title: "Finish CN lab report", priority: "High", status: "Pending", category: "Networks", deadline: "2030-01-31" };

test("GET /api/health returns ok when KV is bound", async () => {
  const res = await call("GET", "/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.data.status, "ok");
  assert.equal(res.data.kvBound, true);
});

test("GET /api/health returns 503 when the KV binding is missing", async () => {
  env = {};
  const res = await call("GET", "/api/health");
  assert.equal(res.status, 503);
  assert.equal(res.data.kvBound, false);
});

test("POST /api/tasks creates a task with an ID and creation date", async () => {
  const res = await call("POST", "/api/tasks", sample);
  assert.equal(res.status, 201);
  assert.match(res.data.data.id, /^[0-9a-f-]{36}$/);
  assert.equal(res.data.data.title, sample.title);
  assert.ok(!Number.isNaN(Date.parse(res.data.data.createdAt)));
});

test("POST applies defaults for optional fields", async () => {
  const res = await call("POST", "/api/tasks", { title: "  Read chapter 4  " });
  assert.equal(res.status, 201);
  assert.equal(res.data.data.title, "Read chapter 4");
  assert.equal(res.data.data.priority, "Medium");
  assert.equal(res.data.data.status, "Pending");
  assert.equal(res.data.data.deadline, null);
});

test("POST rejects invalid input with 400 and clear details", async () => {
  const bad = [
    {},
    { title: "" },
    { title: "x".repeat(121) },
    { title: "ok", priority: "Urgent" },
    { title: "ok", status: "Done" },
    { title: "ok", deadline: "31-01-2030" },
    { title: "ok", deadline: "2030-02-30" },
    ["not", "an", "object"],
  ];
  for (const body of bad) {
    const res = await call("POST", "/api/tasks", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.data.error.message);
  }
  const res = await call("POST", "/api/tasks", { title: "ok", priority: "Urgent" });
  assert.match(res.data.error.details[0], /priority must be one of/);
});

test("POST rejects malformed JSON with 400", async () => {
  const res = await call("POST", "/api/tasks", undefined, "{not json");
  assert.equal(res.status, 400);
  assert.match(res.data.error.message, /valid JSON/);
});

test("POST rejects oversized bodies with 413", async () => {
  const res = await call("POST", "/api/tasks", { title: "a", notes: "x".repeat(20000) });
  assert.equal(res.status, 413);
});

test("GET /api/tasks lists tasks, newest first", async () => {
  await call("POST", "/api/tasks", { title: "first" });
  await new Promise((r) => setTimeout(r, 5));
  await call("POST", "/api/tasks", { title: "second" });
  const res = await call("GET", "/api/tasks");
  assert.equal(res.status, 200);
  assert.equal(res.data.count, 2);
  assert.deepEqual(res.data.data.map((t) => t.title), ["second", "first"]);
});

test("GET /api/tasks/:id returns one task, 404 when missing", async () => {
  const created = (await call("POST", "/api/tasks", sample)).data.data;
  const found = await call("GET", `/api/tasks/${created.id}`);
  assert.equal(found.status, 200);
  assert.equal(found.data.data.title, sample.title);
  const missing = await call("GET", "/api/tasks/does-not-exist");
  assert.equal(missing.status, 404);
});

test("PUT /api/tasks/:id updates only the given fields", async () => {
  const created = (await call("POST", "/api/tasks", sample)).data.data;
  const res = await call("PUT", `/api/tasks/${created.id}`, { status: "Completed" });
  assert.equal(res.status, 200);
  assert.equal(res.data.data.status, "Completed");
  assert.equal(res.data.data.title, sample.title);
  assert.equal(res.data.data.createdAt, created.createdAt);
  const clear = await call("PUT", `/api/tasks/${created.id}`, { deadline: null, category: "" });
  assert.equal(clear.data.data.deadline, null);
  assert.equal(clear.data.data.category, "");
});

test("PUT validates input and handles missing tasks", async () => {
  const created = (await call("POST", "/api/tasks", sample)).data.data;
  assert.equal((await call("PUT", `/api/tasks/${created.id}`, { priority: "Nope" })).status, 400);
  assert.equal((await call("PUT", `/api/tasks/${created.id}`, {})).status, 400);
  assert.equal((await call("PUT", "/api/tasks/missing-id", { status: "Pending" })).status, 404);
});

test("DELETE /api/tasks/:id removes the task and its index entry", async () => {
  const created = (await call("POST", "/api/tasks", sample)).data.data;
  const res = await call("DELETE", `/api/tasks/${created.id}`);
  assert.equal(res.status, 200);
  assert.equal((await call("GET", `/api/tasks/${created.id}`)).status, 404);
  assert.equal((await call("GET", "/api/tasks")).data.count, 0);
  assert.deepEqual(JSON.parse(env.TASKS_KV.map.get("index")), []);
  assert.equal((await call("DELETE", `/api/tasks/${created.id}`)).status, 404);
});

test("data persists in KV between requests (simulates a page refresh)", async () => {
  await call("POST", "/api/tasks", sample);
  const again = await worker.fetch(new Request("https://example.test/api/tasks"), env);
  assert.equal((await again.json()).count, 1);
});

test("a lost index is rebuilt automatically from the task keys", async () => {
  const created = (await call("POST", "/api/tasks", sample)).data.data;
  env.TASKS_KV.map.delete("index");
  const res = await call("GET", "/api/tasks");
  assert.equal(res.data.count, 1);
  assert.equal(res.data.data[0].id, created.id);
  assert.deepEqual(JSON.parse(env.TASKS_KV.map.get("index")), [created.id]);
});

test("?repair=true restores a task missing from the index and drops dead IDs", async () => {
  const created = (await call("POST", "/api/tasks", sample)).data.data;
  env.TASKS_KV.map.set("index", JSON.stringify(["ghost-id"]));
  const res = await call("GET", "/api/tasks?repair=true");
  assert.equal(res.data.count, 1);
  assert.equal(res.data.data[0].id, created.id);
  assert.deepEqual(JSON.parse(env.TASKS_KV.map.get("index")), [created.id]);
});

test("the task limit returns 409", async () => {
  const ids = Array.from({ length: 40 }, (_, i) => `id-${i}`);
  env.TASKS_KV.map.set("index", JSON.stringify(ids));
  const res = await call("POST", "/api/tasks", sample);
  assert.equal(res.status, 409);
});

test("OPTIONS returns 204 with CORS headers", async () => {
  const res = await call("OPTIONS", "/api/tasks");
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-methods"), /DELETE/);
});

test("unknown API paths give 404 and wrong methods give 405 with JSON", async () => {
  assert.equal((await call("GET", "/api/nothing")).status, 404);
  const res = await call("PATCH", "/api/tasks");
  assert.equal(res.status, 405);
  assert.match(res.headers.get("allow"), /POST/);
  assert.equal((await call("POST", "/api/health")).status, 405);
});

test("a KV failure becomes a clean 500 JSON error", async () => {
  env.TASKS_KV.put = async () => {
    throw new Error("boom");
  };
  const res = await call("POST", "/api/tasks", sample);
  assert.equal(res.status, 500);
  assert.equal(res.data.error.message, "Internal server error");
});

test("the Worker serves the frontend files", async () => {
  const page = await call("GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.text, /Task Desk/);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  const css = await call("GET", "/style.css");
  assert.match(css.headers.get("content-type"), /text\/css/);
  const js = await call("GET", "/script.js");
  assert.match(js.headers.get("content-type"), /javascript/);
  assert.equal((await call("GET", "/missing.txt")).status, 404);
});
