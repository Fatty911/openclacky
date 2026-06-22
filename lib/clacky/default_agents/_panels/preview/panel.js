// ── Official panel: preview ───────────────────────────────────────────────
//
// Lightweight preview of a local dev server (default http://localhost:3000).
// The address bar + "Open in new tab" is the reliable path: many dev servers
// send X-Frame-Options / frame-ancestors that block embedding, so the inline
// iframe is best-effort and the new-tab button is always offered. Mounted as
// a tab in "session.aside" (order 30), scoped to agents declaring
// `panels: [preview]`. No backend — the URL is purely client-side.
//
// The chosen URL is remembered per browser so it survives session switches.
// ───────────────────────────────────────────────────────────────────────────

(() => {
  if (!window.Clacky || !Clacky.ext) return;

  const STORAGE_KEY = "clacky.preview.url";
  const DEFAULT_URL = "http://localhost:3000";
  const t = (k, fallback) => {
    const v = (typeof I18n !== "undefined") ? I18n.t(k) : null;
    return (v && v !== k) ? v : fallback;
  };

  if (!document.getElementById("preview-panel-style")) {
    const style = document.createElement("style");
    style.id = "preview-panel-style";
    style.textContent = `
      .pv-panel { display: flex; flex-direction: column; flex: 1; min-height: 0; }
      .pv-bar { flex: none; display: flex; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--color-border-secondary); }
      .pv-url { flex: 1; min-width: 0; padding: 6px 10px; border: 1px solid var(--color-border-primary); border-radius: var(--radius-md); background: var(--color-bg-input); color: var(--color-text-primary); font-size: 12px; font-family: ui-monospace, monospace; }
      .pv-url:focus { outline: none; border-color: var(--color-accent-primary); }
      .pv-btn { flex: none; padding: 6px 10px; border: 1px solid var(--color-border-primary); border-radius: var(--radius-md); background: var(--color-bg-secondary); color: var(--color-text-secondary); font-size: 12px; cursor: pointer; }
      .pv-btn:hover { background: var(--color-bg-hover); }
      .pv-btn.go { background: var(--color-accent-primary); color: var(--color-text-inverse); border-color: transparent; }
      .pv-btn.go:hover { background: var(--color-accent-hover); }
      .pv-frame-wrap { flex: 1; min-height: 0; margin: 12px; border: 1px solid var(--color-border-primary); border-radius: var(--radius-md); overflow: hidden; background: var(--color-bg-primary); position: relative; }
      .pv-frame { width: 100%; height: 100%; border: none; display: block; }
      .pv-hint { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 16px; color: var(--color-text-tertiary); font-size: 12px; pointer-events: none; line-height: 1.6; }
    `;
    document.head.appendChild(style);
  }

  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      }
    }
    kids.forEach((c) => node.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return node;
  }

  function normalize(raw) {
    let url = (raw || "").trim();
    if (!url) return "";
    if (!/^https?:\/\//i.test(url)) url = "http://" + url;
    try { return new URL(url).href; } catch (_e) { return ""; }
  }

  Clacky.ext.ui.mount("session.aside", (_ctx) => {
    const stored = (() => { try { return localStorage.getItem(STORAGE_KEY); } catch (_e) { return null; } })();
    const initial = stored || DEFAULT_URL;

    const input = el("input", { type: "text", class: "pv-url", value: initial, placeholder: DEFAULT_URL });
    const frame = el("iframe", { class: "pv-frame", title: "preview", referrerpolicy: "no-referrer" });
    const hint = el("div", { class: "pv-hint", text: t("pv.hint", "在这里输入地址，点击「打开」查看运行效果。\n部分网站不允许内嵌，可点「新标签」在浏览器打开。") });
    const frameWrap = el("div", { class: "pv-frame-wrap" }, frame, hint);

    function commit() {
      const url = normalize(input.value);
      if (!url) { hint.textContent = t("pv.invalid", "这看起来不是一个有效的地址。"); return null; }
      input.value = url;
      try { localStorage.setItem(STORAGE_KEY, url); } catch (_e) { /* ignore */ }
      return url;
    }
    function load() {
      const url = commit(); if (!url) return;
      hint.textContent = "";
      frame.src = url;
    }
    function openTab() {
      const url = commit(); if (!url) return;
      window.open(url, "_blank", "noopener");
    }

    input.addEventListener("keydown", (e) => { if (e.key === "Enter") load(); });
    const loadBtn = el("button", { class: "pv-btn go", type: "button", text: t("pv.load", "打开"), onclick: load });
    const openBtn = el("button", { class: "pv-btn", type: "button", text: t("pv.newTab", "新标签 ↗"), onclick: openTab });

    return el("div", { class: "pv-panel", "data-panel": "preview" },
      el("div", { class: "pv-bar" }, input, loadBtn, openBtn),
      frameWrap,
    );
  }, {
    panel: "preview",
    order: 30,
    tab: { id: "preview", label: (typeof I18n !== "undefined" && I18n.t("pv.tab") !== "pv.tab" ? I18n.t("pv.tab") : "预览") },
  });
})();
