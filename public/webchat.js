/*! OmniReach web chat widget. Vanilla JS, no dependencies.
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
  var FONT = "Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";

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
  function svg(paths, size, stroke) {
    var ns = "http://www.w3.org/2000/svg";
    var s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", size); s.setAttribute("height", size);
    s.setAttribute("fill", "none"); s.setAttribute("stroke", stroke); s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round"); s.setAttribute("aria-hidden", "true");
    paths.forEach(function (d) { var p = document.createElementNS(ns, "path"); p.setAttribute("d", d); s.appendChild(p); });
    return s;
  }
  // readable text colour for any accent colour
  function contrast(hex) {
    var n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#0a0a0a" : "#ffffff";
  }

  var cfg = { title: "Chat with us", welcome: "Hi! How can we help?", color: "#00C16A", collect: false };
  var seen = {}, after = 0, open = false, timer = null, details = null, unread = 0, fastUntil = 0, typingEl = null;

  var host = el("div", "position:fixed;right:20px;bottom:20px;z-index:2147483000;font:14px/1.45 " + FONT + ";");
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  var wrap = el("div", "position:relative;display:flex;flex-direction:column;align-items:flex-end;");

  var panel = el("div", "display:none;flex-direction:column;width:360px;max-width:calc(100vw - 24px);height:520px;max-height:calc(100vh - 110px);background:#0b0b0b;color:#ededed;border:1px solid #2a2a2a;border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.45);overflow:hidden;margin-bottom:12px;");
  var head = el("div", "padding:14px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #2a2a2a;background:#111;");
  var headL = el("div", "display:flex;align-items:center;gap:10px;min-width:0;");
  var dot = el("span", "width:8px;height:8px;border-radius:50%;flex:none;");
  var titles = el("div", "min-width:0;");
  var title = el("div", "font-weight:600;font-size:14px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;");
  var sub = el("div", "font-size:12px;color:#8a8a8a;", "We usually reply within minutes");
  titles.appendChild(title); titles.appendChild(sub); headL.appendChild(dot); headL.appendChild(titles);
  var close = el("button", "background:none;border:0;color:#8a8a8a;cursor:pointer;padding:4px;border-radius:6px;display:flex;");
  close.type = "button"; close.setAttribute("aria-label", "Close chat"); close.appendChild(svg(["M18 6 6 18", "M6 6l12 12"], 18, "currentColor"));
  head.appendChild(headL); head.appendChild(close);

  var list = el("div", "flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;background:#000;");
  list.setAttribute("aria-live", "polite");

  var form = el("form", "display:flex;gap:8px;padding:12px;border-top:1px solid #2a2a2a;background:#111;");
  var input = el("input", "flex:1;border:1px solid #333;border-radius:8px;padding:10px 12px;font:inherit;color:#fff;background:#000;outline:none;min-width:0;");
  input.type = "text"; input.maxLength = 2000; input.placeholder = "Type your message"; input.setAttribute("aria-label", "Message");
  var send = el("button", "border:0;border-radius:8px;padding:0 12px;cursor:pointer;display:flex;align-items:center;justify-content:center;");
  send.type = "submit"; send.setAttribute("aria-label", "Send");
  form.appendChild(input); form.appendChild(send);

  var info = el("form", "display:none;flex-direction:column;gap:8px;padding:12px;border-top:1px solid #2a2a2a;background:#111;");
  var fieldCss = "border:1px solid #333;border-radius:8px;padding:9px 12px;font:inherit;color:#fff;background:#000;outline:none;";
  var fName = el("input", fieldCss); fName.placeholder = "Your name (optional)"; fName.maxLength = 100;
  var fEmail = el("input", fieldCss); fEmail.type = "email"; fEmail.placeholder = "Email (optional)"; fEmail.maxLength = 254;
  var fPhone = el("input", fieldCss); fPhone.type = "tel"; fPhone.placeholder = "Phone (optional)"; fPhone.maxLength = 32;
  var fGo = el("button", "border:0;border-radius:8px;padding:10px;cursor:pointer;font:inherit;font-weight:600;", "Start chat"); fGo.type = "submit";
  info.appendChild(fName); info.appendChild(fEmail); info.appendChild(fPhone); info.appendChild(fGo);

  var powered = el("a", "display:block;text-align:center;padding:6px;font-size:11px;color:#6a6a6a;background:#111;text-decoration:none;border-top:1px solid #1d1d1d;", "Powered by OmniReach");
  powered.href = "https://galactech.pro"; powered.target = "_blank"; powered.rel = "noopener noreferrer";

  panel.appendChild(head); panel.appendChild(list); panel.appendChild(info); panel.appendChild(form); panel.appendChild(powered);

  var bubble = el("button", "width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(0,0,0,.35);transition:transform .15s;");
  bubble.type = "button"; bubble.setAttribute("aria-label", "Open chat");
  bubble.addEventListener("mouseenter", function () { bubble.style.transform = "scale(1.06)"; });
  bubble.addEventListener("mouseleave", function () { bubble.style.transform = "scale(1)"; });
  var badge = el("span", "position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;border-radius:10px;background:#ff4444;color:#fff;font-size:11px;font-weight:600;line-height:20px;text-align:center;display:none;pointer-events:none;");
  var bw = el("div", "position:relative;"); bw.appendChild(bubble); bw.appendChild(badge);
  wrap.appendChild(panel); wrap.appendChild(bw); root.appendChild(wrap);

  function paint() {
    var fg = contrast(cfg.color);
    bubble.style.background = cfg.color; send.style.background = cfg.color; fGo.style.background = cfg.color; fGo.style.color = fg;
    dot.style.background = cfg.color; title.textContent = cfg.title;
    bubble.textContent = ""; send.textContent = "";
    bubble.appendChild(svg(["M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.6-.8L3 21l1.9-5.4A8.4 8.4 0 1 1 21 11.5z"], 26, fg));
    send.appendChild(svg(["M22 2 11 13", "M22 2l-7 20-4-9-9-4 20-7z"], 18, fg));
    sendFg = fg;
  }
  var sendFg = "#fff";
  function addMsg(from, text, id) {
    if (id) { if (seen[id]) return; seen[id] = 1; }
    hideTyping();
    var visitorMsg = from === "visitor";
    var m = el("div", "max-width:82%;padding:9px 12px;border-radius:10px;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;" +
      (visitorMsg ? "align-self:flex-end;background:" + cfg.color + ";color:" + contrast(cfg.color) + ";border-bottom-right-radius:3px;" : "align-self:flex-start;background:#1a1a1a;color:#ededed;border:1px solid #2a2a2a;border-bottom-left-radius:3px;"));
    m.textContent = text; // never innerHTML
    list.appendChild(m); list.scrollTop = list.scrollHeight;
    if (from === "agent" && !open) { unread++; badge.textContent = String(Math.min(unread, 9)); badge.style.display = "block"; }
  }
  function showTyping() {
    if (typingEl) return;
    typingEl = el("div", "align-self:flex-start;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;border-bottom-left-radius:3px;padding:10px 12px;color:#8a8a8a;letter-spacing:2px;", "...");
    list.appendChild(typingEl); list.scrollTop = list.scrollHeight;
    setTimeout(hideTyping, 15000);
  }
  function hideTyping() { if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl); typingEl = null; }
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
    // poll quickly right after the visitor writes (AI/agent replies usually arrive within seconds), slowly otherwise
    var wait = open ? (Date.now() < fastUntil ? 1500 : 4000) : 20000;
    timer = setTimeout(function () { if (!document.hidden) poll(false); schedule(); }, wait);
  }
  function toggle(o) {
    open = o; panel.style.display = o ? "flex" : "none"; bubble.setAttribute("aria-label", o ? "Close chat" : "Open chat");
    if (o) { unread = 0; badge.style.display = "none"; input.focus(); poll(false); }
    schedule();
  }
  bubble.addEventListener("click", function () { toggle(!open); });
  close.addEventListener("click", function () { toggle(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && open) toggle(false); });
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
    fastUntil = Date.now() + 45000; showTyping(); schedule();
    var body = { visitor_id: visitor, text: text, client_id: rand(8) };
    if (details) { body.name = details.name; body.email = details.email; body.phone = details.phone; details = Object.assign({}, details); }
    req("/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(function (r) {
      if (!r.ok) { hideTyping(); addMsg("agent", r.status === 429 ? "You are sending messages too quickly. Please wait a moment." : "Sorry, your message could not be sent."); }
    }).catch(function () { hideTyping(); addMsg("agent", "Network error. Please try again."); });
  });

  document.body.appendChild(host);
  paint();
  poll(true);
  schedule();
})();
