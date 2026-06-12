// share.js — Share hooks for spreading the word at peak-delight moments.
//
// Two entry points, one shared UI:
//   Share.openModal()              — always-available header button
//   Share.maybePromptOnComplete()  — fires after a task succeeds, gated by
//                                    a frequency cap (first + 5th success,
//                                    then a 7-day cooldown after dismissal)
//
// Brand-aware: when this install is white-labelled, ALL share content
// (product name, landing link, QR target, logo) switches to the brand's
// values. It NEVER leaks "OpenClacky" / openclacky.com into a branded build.
//
// Depends on: qrcode (vendor/qrcode/qrcode.min.js), I18n, Modal.toast.
// ─────────────────────────────────────────────────────────────────────────
const Share = (() => {
  const DEFAULT_NAME     = "OpenClacky";
  const DEFAULT_HOMEPAGE = "https://www.openclacky.com/";

  const COUNT_KEY    = "clacky-share-success-count";
  const COOLDOWN_KEY = "clacky-share-cooldown-until";
  const COOLDOWN_MS  = 7 * 24 * 60 * 60 * 1000;
  const PROMPT_AT    = [1, 5]; // success counts that trigger an auto-prompt

  // Brand info, hydrated once from /api/brand/status. Falls back to defaults
  // (un-branded OpenClacky) until the fetch resolves or if it fails.
  let _brand = { name: DEFAULT_NAME, homepageUrl: DEFAULT_HOMEPAGE, logoUrl: null };

  // ── Brand source (single source of truth) ─────────────────────────────
  async function _hydrateBrand() {
    try {
      const res = await fetch("/api/brand/status");
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.branded) {
        _brand = {
          name:        (data.product_name || "").trim() || DEFAULT_NAME,
          // Branded builds must NEVER fall back to openclacky.com. If the brand
          // has no homepage configured, we simply show no link / QR.
          homepageUrl: (data.homepage_url || "").trim() || null,
          logoUrl:     (data.logo_url || "").trim() || null
        };
      }
    } catch (_e) { /* keep defaults */ }
  }

  // ── Share copy (i18n + brand interpolation) ───────────────────────────
  function _text() {
    return I18n.t("share.copy", { brand: _brand.name }).trim();
  }

  function _shareUrl() {
    return _brand.homepageUrl; // null when branded build has no homepage
  }

  // ── Frequency cap (C2: first + 5th, 7-day cooldown after dismissal) ────
  function _successCount() {
    return parseInt(localStorage.getItem(COUNT_KEY) || "0", 10) || 0;
  }

  function _bumpSuccessCount() {
    const n = _successCount() + 1;
    localStorage.setItem(COUNT_KEY, String(n));
    return n;
  }

  function _inCooldown() {
    const until = parseInt(localStorage.getItem(COOLDOWN_KEY) || "0", 10) || 0;
    return Date.now() < until;
  }

  function _startCooldown() {
    localStorage.setItem(COOLDOWN_KEY, String(Date.now() + COOLDOWN_MS));
  }

  // ── QR code (reuses qrcode-generator) ─────────────────────────────────
  // Draws the QR for `url` onto a canvas 2d context at (x, y) sized `sizePx`.
  function _drawQrToCanvas(ctx, url, x, y, sizePx) {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    const count = qr.getModuleCount();
    const quiet = 2;
    const total = count + quiet * 2;
    const module = sizePx / total;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x, y, sizePx, sizePx);
    ctx.fillStyle = "#1a1a1a";
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          ctx.fillRect(
            x + (c + quiet) * module,
            y + (r + quiet) * module,
            Math.ceil(module),
            Math.ceil(module)
          );
        }
      }
    }
  }

  // ── Poster (pure-frontend Canvas, zero token, instant) ────────────────
  // Returns a data URL (PNG) of a vertical share card.
  function _buildPoster() {
    const W = 720, H = 1280;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");

    // Background gradient.
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#0f172a");
    grad.addColorStop(1, "#1e293b");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Brand name.
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.font = "700 64px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    ctx.fillText(_brand.name, W / 2, 220);

    // Tagline (wrapped).
    ctx.fillStyle = "#cbd5e1";
    ctx.font = "400 34px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    const tagline = I18n.t("share.poster.tagline", { brand: _brand.name });
    _wrapText(ctx, tagline, W / 2, 360, W - 160, 50);

    // QR code (only when there's a URL to point at).
    const url = _shareUrl();
    if (url) {
      const qrSize = 340;
      const qrX = (W - qrSize) / 2;
      const qrY = 640;
      // White rounded backing plate.
      ctx.fillStyle = "#ffffff";
      _roundRect(ctx, qrX - 28, qrY - 28, qrSize + 56, qrSize + 56, 24);
      ctx.fill();
      _drawQrToCanvas(ctx, url, qrX, qrY, qrSize);

      ctx.fillStyle = "#94a3b8";
      ctx.font = "400 28px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
      ctx.fillText(I18n.t("share.poster.scan"), W / 2, qrY + qrSize + 90);

      ctx.fillStyle = "#64748b";
      ctx.font = "400 24px -apple-system, sans-serif";
      ctx.fillText(url.replace(/^https?:\/\//, "").replace(/\/$/, ""), W / 2, H - 80);
    }

    return canvas.toDataURL("image/png");
  }

  function _wrapText(ctx, text, cx, startY, maxWidth, lineHeight) {
    const words = text.split("");
    let line = "", y = startY;
    for (const ch of words) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, cx, y);
        line = ch;
        y += lineHeight;
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, cx, y);
  }

  function _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ── Platform actions ──────────────────────────────────────────────────
  function _copy(str) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(str).then(
        () => Modal.toast(I18n.t("share.copied"), "success"),
        () => _copyFallback(str)
      );
    } else {
      _copyFallback(str);
    }
  }

  function _copyFallback(str) {
    const ta = document.createElement("textarea");
    ta.value = str;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); Modal.toast(I18n.t("share.copied"), "success"); }
    catch (_e) { Modal.toast(I18n.t("share.copyFailed"), "error"); }
    finally { ta.remove(); }
  }

  function _shareText() {
    const url = _shareUrl();
    const body = _text();
    return url ? `${body} ${url}` : body;
  }

  function _toWeibo() {
    const url = _shareUrl() || "";
    const share = "https://service.weibo.com/share/share.php?url=" +
      encodeURIComponent(url) + "&title=" + encodeURIComponent(_text());
    window.open(share, "_blank", "noopener,noreferrer");
  }

  function _copyForPlatform() { _copy(_shareText()); }

  function _downloadPoster() {
    const a = document.createElement("a");
    a.href = _buildPoster();
    a.download = `${_brand.name.toLowerCase()}-share.png`;
    a.click();
  }

  // ── Modal UI ──────────────────────────────────────────────────────────
  let _overlay = null;

  function openModal() {
    if (_overlay) closeModal();

    const hasUrl = !!_shareUrl();
    const o = document.createElement("div");
    o.className = "share-overlay";
    o.innerHTML =
      '<div class="share-modal" role="dialog" aria-modal="true">' +
        '<button type="button" class="share-close" aria-label="Close">&times;</button>' +
        '<h3 class="share-title">' + _esc(I18n.t("share.modal.title", { brand: _brand.name })) + '</h3>' +
        '<p class="share-subtitle">' + _esc(I18n.t("share.modal.subtitle")) + '</p>' +
        '<div class="share-poster-wrap"><img class="share-poster-img" alt="poster"/></div>' +
        '<div class="share-platforms">' +
          '<button type="button" class="share-platform" data-act="weibo">' + _esc(I18n.t("share.platform.weibo")) + '</button>' +
          '<button type="button" class="share-platform" data-act="xhs">' + _esc(I18n.t("share.platform.xhs")) + '</button>' +
          '<button type="button" class="share-platform" data-act="wechat">' + _esc(I18n.t("share.platform.wechat")) + '</button>' +
          '<button type="button" class="share-platform" data-act="bilibili">' + _esc(I18n.t("share.platform.bilibili")) + '</button>' +
        '</div>' +
        '<div class="share-actions">' +
          (hasUrl ? '<button type="button" class="share-btn-secondary" data-act="copylink">' + _esc(I18n.t("share.action.copyLink")) + '</button>' : '') +
          '<button type="button" class="share-btn-primary" data-act="download">' + _esc(I18n.t("share.action.download")) + '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(o);
    _overlay = o;

    // Render the poster preview.
    try { o.querySelector(".share-poster-img").src = _buildPoster(); }
    catch (_e) { o.querySelector(".share-poster-wrap").style.display = "none"; }

    const close = () => closeModal();
    o.querySelector(".share-close").onclick = close;
    o.addEventListener("click", (e) => { if (e.target === o) close(); });

    o.querySelectorAll("[data-act]").forEach((btn) => {
      btn.onclick = () => {
        switch (btn.getAttribute("data-act")) {
          case "weibo":    _toWeibo(); break;
          case "xhs":      _copyForPlatform(); Modal.toast(I18n.t("share.hint.xhs"), "info"); break;
          case "wechat":   _copyForPlatform(); Modal.toast(I18n.t("share.hint.wechat"), "info"); break;
          case "bilibili": _copyForPlatform(); break;
          case "copylink": _copy(_shareUrl()); break;
          case "download": _downloadPoster(); break;
        }
      };
    });

    requestAnimationFrame(() => o.classList.add("open"));
  }

  function closeModal() {
    if (!_overlay) return;
    const o = _overlay;
    _overlay = null;
    o.classList.remove("open");
    setTimeout(() => o.remove(), 200);
  }

  // ── Auto-prompt at peak-delight moments ───────────────────────────────
  // Called from ws-dispatcher on a successful `complete` event (the active
  // session the user is watching — onboarding runs in its own panel, never
  // emitting this for the chat view). Shows a gentle toast, not a modal,
  // so we never interrupt the moment.
  function maybePromptOnComplete() {
    const n = _bumpSuccessCount();
    if (_inCooldown()) return;
    if (!PROMPT_AT.includes(n)) return;

    Modal.toast(I18n.t("share.prompt.message", { brand: _brand.name }), "success", {
      duration: 8000,
      action: {
        label: I18n.t("share.prompt.action"),
        onClick: openModal
      }
    });
    // Any prompt (taken or ignored) starts the cooldown so we stay quiet
    // for the next 7 days regardless.
    _startCooldown();
  }

  function _esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ── Init ──────────────────────────────────────────────────────────────
  function init() {
    _hydrateBrand();
    const btn = document.getElementById("share-toggle-header");
    if (btn) btn.addEventListener("click", openModal);
  }

  return { init, openModal, closeModal, maybePromptOnComplete };
})();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => Share.init());
} else {
  Share.init();
}
