const test = require("node:test");
const assert = require("node:assert/strict");
const V = require("../src/vault.js");
const S = require("../src/sync.js");

test("vault: right PIN unlocks and decrypts, wrong PIN doesn't", async () => {
  assert.equal(V.available(), true);
  const { meta, key } = await V.createLock("482913", 20000);
  const box = await V.encrypt(key, { jobs: [{ title: "Picker" }] });
  assert.ok(V.isBox(box));
  assert.doesNotMatch(JSON.stringify(box), /Picker/);
  const again = await V.unlock(meta, "482913");
  assert.ok(again);
  assert.deepEqual(await V.decrypt(again, box), { jobs: [{ title: "Picker" }] });
  assert.equal(await V.unlock(meta, "000000"), null);
  // A different lock (new salt) can't read the old data.
  const other = await V.createLock("482913", 20000);
  await assert.rejects(V.decrypt(other.key, box));
});

test("vault: PIN rules and lockout times", () => {
  assert.equal(V.validPin("1234"), true);
  assert.equal(V.validPin("12345678"), true);
  assert.equal(V.validPin("123"), false);
  assert.equal(V.validPin("12a4"), false);
  assert.equal(V.lockoutMs(4), 0);
  assert.equal(V.lockoutMs(5), 30000);
  assert.equal(V.lockoutMs(6), 60000);
  assert.equal(V.lockoutMs(20), 15 * 60000);
});

function fakeServer() {
  const calls = [];
  let row = null;
  const reply = (status, body) => ({ ok: status < 400, status, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ path: u.pathname + u.search, method: opts.method || "GET", headers: opts.headers, body });
    if (u.pathname === "/auth/v1/otp") return reply(200, {});
    if (u.pathname === "/auth/v1/verify") return body.token === "123456" ? reply(200, { access_token: "at", refresh_token: "rt", expires_in: 3600, user: { id: "u1", email: body.email } }) : reply(403, { msg: "Token has expired or is invalid" });
    if (u.pathname === "/rest/v1/workspaces" && (opts.method || "GET") === "GET") return reply(200, row ? [row] : []);
    if (u.pathname === "/rest/v1/workspaces" && opts.method === "POST") { row = { data: body.data, rev: 1 }; return reply(201, [row]); }
    if (u.pathname === "/rest/v1/workspaces" && opts.method === "PATCH") {
      const rev = Number(u.searchParams.get("rev").replace("eq.", ""));
      if (!row || row.rev !== rev) return reply(200, []);
      row = { data: body.data, rev: body.rev };
      return reply(200, [row]);
    }
    return reply(404, { message: "not found" });
  };
  return { fetch, calls, setRow: (r) => (row = r), getRow: () => row };
}

test("sync: email code sign-in, create, push with revision check", async () => {
  const srv = fakeServer();
  const c = S.createClient({ url: "https://abc.supabase.co/", anonKey: "anon" }, srv.fetch);
  await c.sendCode("me@example.com");
  assert.deepEqual(srv.calls[0].body, { email: "me@example.com", create_user: true });
  assert.equal(srv.calls[0].headers.apikey, "anon");
  await assert.rejects(c.verifyCode("me@example.com", "000000"), /invalid/);
  const s = await c.verifyCode("me@example.com", "123456");
  assert.equal(s.user.id, "u1");
  assert.equal(await c.pull(s), null);
  const created = await c.create(s, { jobs: [] });
  assert.equal(created.rev, 1);
  const pushed = await c.push(s, { jobs: [1] }, 1);
  assert.equal(pushed.rev, 2);
  // Another device saved first: the stale push is refused instead of overwriting.
  assert.equal(await c.push(s, { jobs: ["stale"] }, 1), null);
  assert.deepEqual(srv.getRow().data, { jobs: [1] });
  assert.match(srv.calls.at(-1).path, /user_id=eq\.u1&rev=eq\.1/);
  assert.equal(srv.calls.at(-1).headers.Authorization, "Bearer at");
});

test("sync: offline errors are marked, config is checked", async () => {
  const c = S.createClient({ url: "https://abc.supabase.co", anonKey: "k" }, async () => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(c.sendCode("a@b.co"), (e) => e.offline === true);
  assert.equal(S.configured({ url: "https://abc.supabase.co", anonKey: "k" }), true);
  assert.equal(S.configured({ url: "http://abc.supabase.co", anonKey: "k" }), false);
  assert.equal(S.configured(null), false);
  assert.equal(S.validEmail("me@example.com"), true);
  assert.equal(S.validEmail("me@"), false);
  assert.equal(S.needsRefresh({ expires_at: Date.now() + 30000 }), true);
  assert.equal(S.needsRefresh({ expires_at: Date.now() + 600000 }), false);
});
