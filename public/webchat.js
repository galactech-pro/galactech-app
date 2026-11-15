/*! GalacTech web chat widget. Vanilla JS, no dependencies.
 * Usage: <script src="https://YOUR-APP/webchat.js" data-token="INBOX_TOKEN" async></script>
 * Security: every piece of text (visitor, agent, config) is inserted with textContent only; innerHTML is never used.
 * The visitor id lives in localStorage; the host page origin must be in the inbox's allowed-origins list.
 */
(function () {
  "use strict";
  var script = document.currentScript || document.querySelector("script[data-token][src*='webchat.js']");
  if (!script || window.__omnireachChat) return;
  var token = script.getAttribute("data-token") || "";
  if (!/^[a-f0-9]{48}$/.test(token)) return;
  window.__omnireachChat = true;
  var origin;
  try { origin = new URL(script.src).origin; } catch (e) { return; }
  var base = origin + "/api/webhooks/webchat/" + token;
  var KEY = "omnireach_visitor_" + token.slice(0, 8);

  function rand(n) {
    var a = new Uint8Array(n), s = "";
    (window.crypto || window.msCrypto).getRandomValues(a);
    for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? "0" : "") + a[i].toString(16);
    return s;
  }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  var visitor = store(KEY);
  if (!visitor || !/^[A-Za-z0-9_-]{16,64}$/.test(visitor)) { visitor = rand(16); store(KEY, visitor); }

  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text) e.textContent = text;
    return e;
  }

  var cfg = { title: "Chat with us", welcome: "Hi! How can we help?", color: "#2563eb", collect: false };
  var seen = {}, after = 0, open = false, timer = null, details = null, unread = 0;

  var host = el("div", "position:fixed;right:20px;bottom:20px;z-index:2147483000;font:14px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;");
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  var bubble = el("button", "width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;color:#fff;font-size:24px;box-shadow:0 4px 14px rgba(0,0,0,.25);");
  bubble.type = "button";
  bubble.setAttribute("aria-label", "Open chat");
  bubble.textContent = "💬";
  var badge = el("span", "position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;border-radius:9px;background:#dc2626;color:#fff;font-size:11px;line-height:18px;text-align:center;display:none;");
  var panel = el("div", "display:none;flex-direction:column;width:340px;max-width:calc(100vw - 24px);height:480px;max-height:calc(100vh - 100px);background:#fff;color:#111;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.3);overflow:hidden;margin-bottom:12px;");
  var head = el("div", "padding:12px 14px;color:#fff;font-weight:600;display:flex;justify-content:space-between;align-items:center;");
  var title = el("span"); var close = el("button", "background:none;border:0;color:#fff;font-size:20px;cursor:pointer;line-height:1;", "×");
  close.type = "button"; close.setAttribute("aria-label", "Close chat");
  head.appendChild(title); head.appendChild(close);
  var list = el("div", "flex:1;overflow-y:auto;padding:12px;background:#f6f7f9;display:flex;flex-direction:column;gap:8px;");
  list.setAttribute("aria-live", "polite");
  var form = el("form", "display:flex;gap:6px;padding:10px;border-top:1px solid #e5e7eb;background:#fff;");
  var input = el("input", "flex:1;border:1px solid #d1d5db;border-radius:8px;padding:8px 10px;font:inherit;color:#111;background:#fff;");
  input.type = "text"; input.maxLength = 2000; input.placeholder = "Type a message"; input.setAttribute("aria-label", "Message");
  var send = el("button", "border:0;border-radius:8px;color:#fff;padding:0 14px;cursor:pointer;font:inherit;", "Send");
  send.type = "submit";
  form.appendChild(input); form.appendChild(send);
  var info = el("form", "display:none;flex-direction:column;gap:6px;padding:10px;border-top:1px solid #e5e7eb;background:#fff;");
  var fName = el("input", "border:1px solid #d1d5db;border-radius:8px;padding:7px 9px;font:inherit;"); fName.placeholder = "Your name (optional)"; fName.maxLength = 100;
  var fEmail = el("input", "border:1px solid #d1d5db;border-radius:8px;padding:7px 9px;font:inherit;"); fEmail.type = "email"; fEmail.placeholder = "Email (optional)"; fEmail.maxLength = 254;
  var fPhone = el("input", "border:1px solid #d1d5db;border-radius:8px;padding:7px 9px;font:inherit;"); fPhone.type = "tel"; fPhone.placeholder = "Phone (optional)"; fPhone.maxLength = 32;
  var fGo = el("button", "border:0;border-radius:8px;color:#fff;padding:8px;cursor:pointer;font:inherit;", "Start chat"); fGo.type = "submit";
  info.appendChild(fName); info.appendChild(fEmail); info.appendChild(fPhone); info.appendChild(fGo);
  panel.appendChild(head); panel.appendChild(list); panel.appendChild(info); panel.appendChild(form);
  var wrap = el("div", "position:relative;display:flex;flex-direction:column;align-items:flex-end;");
  wrap.appendChild(panel); var bw = el("div", "position:relative;"); bw.appendChild(bubble); bw.appendChild(badge); wrap.appendChild(bw);
  root.appendChild(wrap);

  function paint() {
    bubble.style.background = cfg.color; head.style.background = cfg.color; send.style.background = cfg.color; fGo.style.background = cfg.color;
    title.textContent = cfg.title;
  }
  function addMsg(from, text, id) {
    if (id) { if (seen[id]) return; seen[id] = 1; }
    var m = el("div", "max-width:80%;padding:8px 10px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;" +
      (from === "visitor" ? "align-self:flex-end;background:" + cfg.color + ";color:#fff;" : "align-self:flex-start;background:#fff;color:#111;border:1px solid #e5e7eb;"));
    m.textContent = text; // never innerHTML
    list.appendChild(m); list.scrollTop = list.scrollHeight;
    if (from === "agent" && !open) { unread++; badge.textContent = String(Math.min(unread, 9)); badge.style.display = "block"; }
  }
  function req(path, opts) {
    return fetch(base + path, opts).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); });
  }
  function apply(data, init) {
    (data.messages || []).forEach(function (m) {
      if (typeof m.text !== "string") return;
      if (typeof m.at === "number" && m.at > after) after = m.at;
      if (init || m.from === "agent") addMsg(m.from === "agent" ? "agent" : "visitor", m.text, String(m.id));
    });
  }
  function poll(init) {
    req("/poll?visitor_id=" + encodeURIComponent(visitor) + "&after=" + after + (init ? "&init=1" : "")).then(function (r) {
      if (!r.ok || !r.body || !r.body.data) return;
      if (init && r.body.data.config) { var c = r.body.data.config; cfg = { title: String(c.title || cfg.title), welcome: String(c.welcome || cfg.welcome), color: /^#[0-9a-fA-F]{6}$/.test(c.color) ? c.color : cfg.color, collect: !!c.collect }; paint(); }
      var hadHistory = (r.body.data.messages || []).length > 0;
      if (init && !hadHistory) { addMsg("agent", cfg.welcome); if (cfg.collect && !details) { info.style.display = "flex"; form.style.display = "none"; } }
      apply(r.body.data, init);
    }).catch(function () {});
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(function () { if (!document.hidden) poll(false); schedule(); }, open ? 4000 : 20000);
  }
  function toggle(o) {
    open = o; panel.style.display = o ? "flex" : "none";
    if (o) { unread = 0; badge.style.display = "none"; input.focus(); poll(false); }
    schedule();
  }
  bubble.addEventListener("click", function () { toggle(!open); });
  close.addEventListener("click", function () { toggle(false); });
  info.addEventListener("submit", function (e) {
    e.preventDefault();
    details = { name: fName.value.trim(), email: fEmail.value.trim(), phone: fPhone.value.trim() };
    info.style.display = "none"; form.style.display = "flex"; input.focus();
  });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    addMsg("visitor", text);
    var body = { visitor_id: visitor, text: text, client_id: rand(8) };
    if (details) { body.name = details.name; body.email = details.email; body.phone = details.phone; details = Object.assign({}, details); }
    req("/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(function (r) {
      if (!r.ok) addMsg("agent", r.status === 429 ? "You are sending messages too quickly. Please wait a moment." : "Sorry, your message could not be sent.");
    }).catch(function () { addMsg("agent", "Network error. Please try again."); });
  });

  document.body.appendChild(host);
  paint();
  poll(true);
  schedule();
})();
