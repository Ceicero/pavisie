// CareerCrumbs accounts and sync, using Supabase's REST endpoints directly (no SDK).
// Sign-in is a 6-digit code sent by email: it works inside the Android app, where Google sign-in
// isn't allowed in web views and email links would open the browser instead.
// Each account has one row: the whole workspace as JSON plus a revision number. A save only
// succeeds against the revision it started from, so two devices never silently overwrite each other.
(function (root) {
  "use strict";

  function createClient(cfg, fetchImpl) {
    const base = String(cfg.url || "").replace(/\/+$/, "");
    const doFetch = fetchImpl || root.fetch.bind(root);
    const headers = (token, extra) => Object.assign({ apikey: cfg.anonKey, "Content-Type": "application/json", Authorization: "Bearer " + (token || cfg.anonKey) }, extra || {});

    async function call(path, opts) {
      let r;
      try {
        r = await doFetch(base + path, opts);
      } catch (e) {
        const err = new Error("You're offline or the server can't be reached.");
        err.offline = true;
        throw err;
      }
      const text = await r.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch (e) {}
      if (!r.ok) {
        const msg = body && (body.msg || body.message || body.error_description || body.error);
        const err = new Error(msg || "Request failed (" + r.status + ")");
        err.status = r.status;
        throw err;
      }
      return body;
    }
    const toSession = (b) => {
      if (!b || !b.access_token || !b.user) throw new Error("Sign-in didn't return a session.");
      return { access_token: b.access_token, refresh_token: b.refresh_token, expires_at: Date.now() + (Number(b.expires_in) || 3600) * 1000, user: { id: b.user.id, email: b.user.email } };
    };
    const rowFilter = (s) => "user_id=eq." + encodeURIComponent(s.user.id);

    return {
      sendCode: (email) => call("/auth/v1/otp", { method: "POST", headers: headers(), body: JSON.stringify({ email, create_user: true }) }),
      verifyCode: async (email, token) => toSession(await call("/auth/v1/verify", { method: "POST", headers: headers(), body: JSON.stringify({ type: "email", email, token }) })),
      refresh: async (s) => toSession(await call("/auth/v1/token?grant_type=refresh_token", { method: "POST", headers: headers(), body: JSON.stringify({ refresh_token: s.refresh_token }) })),
      signOut: (s) => call("/auth/v1/logout", { method: "POST", headers: headers(s.access_token) }).catch(() => null),
      // The account's row, or null if it has none yet.
      pull: async (s) => {
        const rows = await call("/rest/v1/workspaces?select=data,rev,updated_at&" + rowFilter(s), { headers: headers(s.access_token) });
        return (rows && rows[0]) || null;
      },
      create: async (s, data) => {
        const rows = await call("/rest/v1/workspaces", { method: "POST", headers: headers(s.access_token, { Prefer: "return=representation" }), body: JSON.stringify({ user_id: s.user.id, data, rev: 1 }) });
        return rows[0];
      },
      // Saves only if the row is still at `rev`; returns null when another device saved first.
      push: async (s, data, rev) => {
        const rows = await call("/rest/v1/workspaces?" + rowFilter(s) + "&rev=eq." + Number(rev), { method: "PATCH", headers: headers(s.access_token, { Prefer: "return=representation" }), body: JSON.stringify({ data, rev: Number(rev) + 1, updated_at: new Date().toISOString() }) });
        return (rows && rows[0]) || null;
      },
      // Removes the sign-in and, through the database cascade, the saved data.
      deleteAccount: (s) => call("/rest/v1/rpc/delete_my_account", { method: "POST", headers: headers(s.access_token), body: "{}" }),
    };
  }
  // Refresh a minute before expiry.
  const needsRefresh = (s, now) => !s.expires_at || s.expires_at - 60000 < (now || Date.now());
  const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());
  const configured = (cfg) => !!(cfg && /^https:\/\/[^\s"'<>]+$/.test(cfg.url || "") && cfg.anonKey);

  const api = { createClient, needsRefresh, validEmail, configured };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CCSync = api;
})(typeof window !== "undefined" ? window : globalThis);
