/*! OmniReach web chat widget. Vanilla JS, no dependencies.
 * Usage: <script src="https://YOUR-APP/webchat.js" data-token="INBOX_TOKEN" async></script>
 * Optional attributes: data-side="left|right" (edge tab side), data-popup="off" (no automatic welcome pop-up).
 * How it works: on a customer website this file only draws a small edge tab and a centered pop-up, and opens the chat inside a frame
 * served from our own domain (/embed/<token>), so the browser never blocks the chat's requests. Only websites in the channel's
 * allowed list can embed it. Inside the frame the same file runs the chat UI.
 * Security: every piece of text (visitor, agent, config) is inserted with textContent only; innerHTML is never used.
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
  var pageMode = script.getAttribute("data-mode") === "page";
  var embed = script.getAttribute("data-embed") === "1";

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
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function rand(n) {
    var a = new Uint8Array(n), s = "";
    (window.crypto || window.msCrypto).getRandomValues(a);
    for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? "0" : "") + a[i].toString(16);
    return s;
  }
  var CHAT_ICON = ["M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.6-.8L3 21l1.9-5.4A8.4 8.4 0 1 1 21 11.5z"];
  var COLOR_OK = /^#[0-9a-fA-F]{6}$/;

  // =============================================================== chat UI (full page, also the content of the frame)
  function runChat() {
    var visitor = store(KEY);
    if (!visitor || !/^[A-Za-z0-9_-]{16,64}$/.test(visitor)) { visitor = rand(16); store(KEY, visitor); }

    var cfg = { title: "Chat with us", welcome: "Hi! How can we help?", color: "#00C16A", collect: false };
    var seen = {}, after = 0, timer = null, details = null, fastUntil = 0, typingEl = null;

    var host = el("div", "position:fixed;inset:0;z-index:2147483000;font:14px/1.45 " + FONT + ";");
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    var wrap = el("div", "position:absolute;inset:0;display:flex;");
    var panel = el("div", "display:flex;flex-direction:column;width:100%;max-width:760px;height:100%;margin:0 auto;background:#0b0b0b;color:#ededed;overflow:hidden;");
    var head = el("div", "padding:14px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #2a2a2a;background:#111;");
    var headL = el("div", "display:flex;align-items:center;gap:10px;min-width:0;");
    var dot = el("span", "width:8px;height:8px;border-radius:50%;flex:none;");
    var titles = el("div", "min-width:0;");
    var title = el("div", "font-weight:600;font-size:14px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;");
    var sub = el("div", "font-size:12px;color:#8a8a8a;", "We usually reply within minutes");
    titles.appendChild(title); titles.appendChild(sub); headL.appendChild(dot); headL.appendChild(titles);
    var close = el("button", "background:none;border:0;color:#8a8a8a;cursor:pointer;padding:6px;border-radius:6px;display:" + (embed ? "flex" : "none") + ";");
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
    wrap.appendChild(panel); root.appendChild(wrap);

    function tell(type) { if (embed && window.parent !== window) { try { window.parent.postMessage({ omnireach: type }, "*"); } catch (e) {} } }

    function paint() {
      var fg = contrast(cfg.color);
      send.style.background = cfg.color; fGo.style.background = cfg.color; fGo.style.color = fg;
      dot.style.background = cfg.color; title.textContent = cfg.title;
      send.textContent = ""; send.appendChild(svg(["M22 2 11 13", "M22 2l-7 20-4-9-9-4 20-7z"], 18, fg));
    }
    function addMsg(from, text, id) {
      if (id) { if (seen[id]) return; seen[id] = 1; }
      hideTyping();
      var visitorMsg = from === "visitor";
      var m = el("div", "max-width:82%;padding:9px 12px;border-radius:10px;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;" +
        (visitorMsg ? "align-self:flex-end;background:" + cfg.color + ";color:" + contrast(cfg.color) + ";border-bottom-right-radius:3px;" : "align-self:flex-start;background:#1a1a1a;color:#ededed;border:1px solid #2a2a2a;border-bottom-left-radius:3px;"));
      m.textContent = text; // never innerHTML
      list.appendChild(m); list.scrollTop = list.scrollHeight;
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
        if (!r.ok || !r.body || !r.body.data) { if (init) { tell("denied"); if (r.status === 403) addMsg("agent", "Chat is not available on this website."); } return; }
        if (init && r.body.data.config) { var c = r.body.data.config; cfg = { title: String(c.title || cfg.title), welcome: String(c.welcome || cfg.welcome), color: COLOR_OK.test(c.color) ? c.color : cfg.color, collect: !!c.collect }; paint(); }
        var hadHistory = (r.body.data.messages || []).length > 0;
        if (init && !hadHistory) { addMsg("agent", cfg.welcome); if (cfg.collect && !details) { info.style.display = "flex"; form.style.display = "none"; } }
        apply(r.body.data, init);
        if (init) tell("ready");
      }).catch(function () { if (init) tell("denied"); });
    }
    function schedule() {
      clearTimeout(timer);
      // poll quickly right after the visitor writes (AI/agent replies usually arrive within seconds), slowly otherwise
      var wait = Date.now() < fastUntil ? 1500 : 4000;
      timer = setTimeout(function () { if (!document.hidden) poll(false); schedule(); }, wait);
    }
    close.addEventListener("click", function () { tell("close"); });
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

    function mount() {
      if (!document.body) { document.addEventListener("DOMContentLoaded", mount, { once: true }); return; }
      document.body.appendChild(host);
      paint();
      poll(true);
      schedule();
      if (embed) setTimeout(function () { input.focus(); }, 300);
    }
    mount();
  }

  // =============================================================== launcher on the customer's website
  function runLauncher() {
    var side = script.getAttribute("data-side") === "left" ? "left" : "right";
    var popupOn = script.getAttribute("data-popup") !== "off";
    var cfg = { title: "Chat with us", welcome: "Hi! How can we help?", color: "#00C16A" };
    var POPUP_KEY = "omnireach_popup_" + token.slice(0, 8);

    function debug(msg) {
      try { console.warn("OmniReach chat: " + msg); } catch (e) {}
      if (!/[?&]omnireach_debug=1/.test(location.search)) return;
      var add = function () {
        var b = el("div", "position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483000;background:#2a0f0f;color:#ffb4b4;border:1px solid #6b1f1f;border-radius:8px;padding:10px 14px;font:13px/1.4 " + FONT + ";", "OmniReach chat is hidden: " + msg);
        document.body.appendChild(b);
      };
      if (document.body) add(); else document.addEventListener("DOMContentLoaded", add, { once: true });
    }

    function build() {
      if (!document.body) { document.addEventListener("DOMContentLoaded", build, { once: true }); return; }
      var fg = contrast(cfg.color);
      var host = el("div", "position:fixed;inset:0;z-index:2147483000;pointer-events:none;font:14px/1.45 " + FONT + ";");
      var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
      var edge = side === "left" ? "left" : "right";
      var offscreen = side === "left" ? "-120vw" : "120vw";
      var reduce = false;
      try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
      var ease = reduce ? "none" : "transform .45s cubic-bezier(.2,.8,.2,1), opacity .3s";

      // dimmed backdrop behind the pop-ups
      var backdrop = el("div", "position:fixed;inset:0;background:rgba(0,0,0,.55);opacity:0;transition:" + (reduce ? "none" : "opacity .3s") + ";pointer-events:none;");

      // docked tab on the middle of the screen edge, clear of the corner where most sites keep WhatsApp, back-to-top and similar icons
      var tab = el("button", "pointer-events:auto;position:fixed;top:50%;" + edge + ":0;transform:translateY(-50%);border:0;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:8px;padding:14px 9px;background:" + cfg.color + ";color:" + fg + ";border-radius:" + (side === "left" ? "0 12px 12px 0" : "12px 0 0 12px") + ";box-shadow:0 6px 24px rgba(0,0,0,.35);font:600 13px " + FONT + ";");
      tab.type = "button"; tab.setAttribute("aria-label", "Open chat");
      tab.appendChild(svg(CHAT_ICON, 20, fg));
      tab.appendChild(el("span", "writing-mode:vertical-rl;transform:rotate(180deg);letter-spacing:.03em;", "Chat with us"));

      // welcome pop-up: slides in from the edge to the centre of the screen
      var card = el("div", "pointer-events:auto;position:fixed;top:50%;left:50%;width:340px;max-width:calc(100vw - 32px);box-sizing:border-box;background:#0b0b0b;color:#ededed;border:1px solid #2a2a2a;border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.55);padding:20px;opacity:0;visibility:hidden;transform:translate(calc(-50% + " + offscreen + "),-50%);transition:" + ease + ";");
      card.setAttribute("role", "dialog"); card.setAttribute("aria-label", "Chat invitation");
      var cardHead = el("div", "display:flex;align-items:center;gap:10px;margin-bottom:10px;");
      cardHead.appendChild(el("span", "width:10px;height:10px;border-radius:50%;flex:none;background:" + cfg.color + ";"));
      cardHead.appendChild(el("div", "font-weight:600;font-size:15px;color:#fff;", cfg.title));
      var cardText = el("p", "margin:0 0 16px;color:#cfcfcf;font-size:14px;", cfg.welcome);
      var cardGo = el("button", "width:100%;border:0;border-radius:9px;padding:12px;cursor:pointer;font:600 14px " + FONT + ";background:" + cfg.color + ";color:" + fg + ";", "Start chat");
      cardGo.type = "button";
      var cardLater = el("button", "display:block;margin:10px auto 0;background:none;border:0;color:#8a8a8a;cursor:pointer;font:13px " + FONT + ";padding:4px 8px;", "Maybe later");
      cardLater.type = "button";
      card.appendChild(cardHead); card.appendChild(cardText); card.appendChild(cardGo); card.appendChild(cardLater);

      // chat window: centred; the chat itself runs in a frame from our own domain
      var modal = el("div", "pointer-events:auto;position:fixed;top:50%;left:50%;width:420px;max-width:calc(100vw - 24px);height:640px;max-height:calc(100vh - 32px);background:#0b0b0b;border:1px solid #2a2a2a;border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.6);overflow:hidden;opacity:0;visibility:hidden;transform:translate(calc(-50% + " + offscreen + "),-50%);transition:" + ease + ";");
      modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-label", cfg.title);
      var fallback = el("div", "position:absolute;inset:0;display:none;align-items:center;justify-content:center;text-align:center;padding:24px;color:#cfcfcf;background:#0b0b0b;", "Chat could not load right now. Please try again in a moment.");
      var frame = null;

      root.appendChild(backdrop); root.appendChild(tab); root.appendChild(card); root.appendChild(modal);
      document.body.appendChild(host);

      var mode = "tab"; // tab | card | chat
      function show(node, on) {
        if (on) { node.style.visibility = "visible"; node.style.opacity = "1"; node.style.transform = "translate(-50%,-50%)"; }
        else { node.style.opacity = "0"; node.style.transform = "translate(calc(-50% + " + offscreen + "),-50%)"; setTimeout(function () { if (node.style.opacity === "0") node.style.visibility = "hidden"; }, reduce ? 0 : 450); }
      }
      function set(next) {
        mode = next;
        show(card, next === "card");
        show(modal, next === "chat");
        var dim = next !== "tab";
        backdrop.style.opacity = dim ? "1" : "0"; backdrop.style.pointerEvents = dim ? "auto" : "none";
        tab.style.display = next === "chat" ? "none" : "flex";
        if (next === "chat") openChat();
      }
      function dismissPopup() { store(POPUP_KEY, String(Date.now())); }
      var ready = false, readyTimer = null;
      function preload() {
        if (!frame) {
          frame = el("iframe", "position:absolute;inset:0;width:100%;height:100%;border:0;background:#0b0b0b;");
          frame.src = origin + "/embed/" + token;
          frame.title = cfg.title;
          frame.setAttribute("allow", "clipboard-write");
          frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox");
          modal.appendChild(frame); modal.appendChild(fallback);
          readyTimer = setTimeout(function () { if (!ready && mode === "chat") fallback.style.display = "flex"; }, 12000);
        }
      }
      function openChat() {
        dismissPopup();
        preload();
        setTimeout(function () { try { frame.focus(); } catch (e) {} }, 400);
      }
      window.addEventListener("message", function (e) {
        if (e.origin !== origin || !frame || e.source !== frame.contentWindow || !e.data || typeof e.data.omnireach !== "string") return;
        if (e.data.omnireach === "ready") { ready = true; fallback.style.display = "none"; clearTimeout(readyTimer); }
        else if (e.data.omnireach === "denied") fallback.style.display = "flex";
        else if (e.data.omnireach === "close") set("tab");
      });
      tab.addEventListener("mouseenter", preload);
      tab.addEventListener("touchstart", preload, { passive: true });
      tab.addEventListener("click", function () { set("chat"); });
      cardGo.addEventListener("click", function () { set("chat"); });
      cardLater.addEventListener("click", function () { dismissPopup(); set("tab"); });
      backdrop.addEventListener("click", function () { if (mode === "card") dismissPopup(); set("tab"); });
      document.addEventListener("keydown", function (e) { if (e.key === "Escape" && mode !== "tab") { if (mode === "card") dismissPopup(); set("tab"); } });

      // invite once a day, a few seconds after the page loads
      var last = Number(store(POPUP_KEY) || 0);
      if (popupOn && (!last || Date.now() - last > 24 * 3600 * 1000)) {
        setTimeout(function () { if (mode === "tab") { preload(); set("card"); } }, 3500);
      }
    }

    // `allowed` tells us whether this website is on the channel's list; on other sites nothing is shown at all
    fetch(base + "/config").then(function (r) { return r.json(); }).then(function (j) {
      var d = j && j.data;
      if (!d) { debug("the chat channel was not found (check the token)"); return; }
      if (!d.allowed) { debug(location.origin + " is not in the allowed websites list. Add it under Channels, Web chat in OmniReach."); return; }
      var c = d.config || {};
      cfg = { title: String(c.title || cfg.title), welcome: String(c.welcome || cfg.welcome), color: COLOR_OK.test(c.color) ? c.color : cfg.color };
      build();
    }).catch(function () { /* offline or blocked: stay hidden */ });
  }

  if (pageMode) runChat(); else runLauncher();
})();
