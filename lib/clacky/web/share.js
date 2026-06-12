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

  const THEME_KEY = "clacky-share-theme"; // remembers last picked poster style
  const DRAFT_KEY = "clacky-share-draft"; // remembers last hand-edited text

  // Poster themes: each is a palette the canvas renderers read from, so the
  // layout stays shared and only colors change. Order = picker order.
  const THEMES = {
    geek: {
      labelKey: "share.theme.geek",
      bg: ["#0f172a", "#1e293b"], scoreBg: ["#0b1220", "#13243b"],
      title: "#ffffff", tagline: "#f1f5f9", period: "#7dd3fc",
      hero: "#38bdf8", metric: "#ffffff", metricLabel: "#cbd5e1",
      golden: "#fcd34d", brand: "#e2e8f0", scan: "#94a3b8", swatch: "#1e293b"
    },
    light: {
      labelKey: "share.theme.light",
      bg: ["#f8fafc", "#e2e8f0"], scoreBg: ["#ffffff", "#eef2f7"],
      title: "#0f172a", tagline: "#475569", period: "#0284c7",
      hero: "#0284c7", metric: "#0f172a", metricLabel: "#64748b",
      golden: "#b45309", brand: "#334155", scan: "#94a3b8", swatch: "#e2e8f0"
    },
    warm: {
      labelKey: "share.theme.warm",
      bg: ["#fff1eb", "#ffd9c0"], scoreBg: ["#fff5f0", "#ffe0cc"],
      title: "#7c2d12", tagline: "#9a3412", period: "#ea580c",
      hero: "#ea580c", metric: "#7c2d12", metricLabel: "#c2410c",
      golden: "#be123c", brand: "#9a3412", scan: "#c2410c", swatch: "#ffd9c0"
    }
  };
  const THEME_ORDER = ["geek", "light", "warm"];

  function _themeId() {
    const saved = localStorage.getItem(THEME_KEY);
    return THEMES[saved] ? saved : "geek";
  }
  function _theme() { return THEMES[_themeId()]; }
  function _setTheme(id) { if (THEMES[id]) localStorage.setItem(THEME_KEY, id); }

  // Brand info, hydrated once from /api/brand/status. Falls back to defaults
  // (un-branded OpenClacky) until the fetch resolves or if it fails.
  let _brand = { name: DEFAULT_NAME, homepageUrl: DEFAULT_HOMEPAGE, logoUrl: null };

  // Current scorecard stats, set by openScorecard() before building the
  // scorecard poster / copy. Null in plain product-share mode.
  let _scorecard = null;

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
  // Candidate variants per platform; the UI shuffles among them and lets the
  // user hand-edit before posting. Product mode shares one generic pool
  // (`share.copy.*`); scorecard mode has per-platform pools with live numbers.
  function _candidatesFor(platform) {
    if (_scorecard) {
      const list = I18n.tList("share.scorecard.copy." + platform, _scorecardVars());
      return list.length ? list : [_scorecardCopy("copylink")];
    }
    const list = I18n.tList("share.copy", { brand: _brand.name });
    return list.length ? list : [I18n.t("share.copy.1", { brand: _brand.name })];
  }

  function _pickCopy(platform, exclude) {
    const list = _candidatesFor(platform).map((s) => s.trim());
    if (list.length <= 1) return list[0] || "";
    let pick = list[Math.floor(Math.random() * list.length)];
    if (exclude != null) {
      let guard = 0;
      while (pick === exclude && guard++ < 8) {
        pick = list[Math.floor(Math.random() * list.length)];
      }
    }
    return pick;
  }

  function _shareUrl() {
    return _brand.homepageUrl; // null when branded build has no homepage
  }

  // ── Scorecard copy (per-platform, numbers from stats) ─────────────────
  // _scorecard = { period, cacheHitRate, costStr, tokensStr, requests }
  function _scorecardVars() {
    return {
      brand:        _brand.name,
      period:       _scorecard.period,
      cacheHitRate: _scorecard.cacheHitRate,
      cost:         _scorecard.costStr,
      tokens:       _scorecard.tokensStr,
      requests:     _scorecard.requests
    };
  }

  function _scorecardCopy(platform) {
    return I18n.t("share.scorecard.copy." + platform + ".1", _scorecardVars()).trim();
  }

  // Pick a dynamic golden line based on how strong the numbers are.
  function _scorecardGoldenLine() {
    const rate = parseFloat(_scorecard.cacheHitRate) || 0;
    const key = rate >= 90 ? "high" : rate >= 60 ? "mid" : "low";
    return I18n.t("share.scorecard.golden." + key, _scorecardVars());
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
  // Returns a data URL (PNG). `copy` is the live editor text, drawn as the
  // poster's main line so the poster matches exactly what the user will post.
  function _buildPoster(copy) {
    const W = 720, H = 1080;
    const t = _theme();
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");

    // Background gradient.
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, t.bg[0]);
    grad.addColorStop(1, t.bg[1]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Brand name.
    ctx.fillStyle = t.title;
    ctx.textAlign = "center";
    ctx.font = "700 60px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    ctx.fillText(_brand.name, W / 2, 150);

    // Main line = the live editor text (so poster === shared text).
    const text = (copy || "").trim() || I18n.t("share.poster.tagline", { brand: _brand.name });
    ctx.fillStyle = t.tagline;
    _drawAutoText(ctx, text, W / 2, 250, W - 120, 480 - 250);

    // QR code (only when there's a URL to point at).
    const url = _shareUrl();
    if (url) {
      const qrSize = 300;
      const qrX = (W - qrSize) / 2;
      const qrY = 560;
      ctx.fillStyle = "#ffffff";
      _roundRect(ctx, qrX - 24, qrY - 24, qrSize + 48, qrSize + 48, 22);
      ctx.fill();
      _drawQrToCanvas(ctx, url, qrX, qrY, qrSize);

      ctx.fillStyle = t.scan;
      ctx.font = "400 28px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
      ctx.fillText(I18n.t("share.poster.scan"), W / 2, qrY + qrSize + 80);

      ctx.fillStyle = t.scan;
      ctx.font = "400 24px -apple-system, sans-serif";
      ctx.fillText(url.replace(/^https?:\/\//, "").replace(/\/$/, ""), W / 2, H - 60);
    }

    return canvas.toDataURL("image/png");
  }

  // ── Scorecard poster (B-line: spend / cache-hit bragging card) ────────
  // Hero = the cache-hit rate (the delight number). Brand is a footer chip.
  function _buildScorecardPoster(copy) {
    const W = 720, H = 1080;
    const t = _theme();
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");

    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, t.scoreBg[0]);
    grad.addColorStop(1, t.scoreBg[1]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    ctx.textAlign = "center";

    // Title + period.
    ctx.fillStyle = t.title;
    ctx.font = "700 48px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    ctx.fillText(I18n.t("share.scorecard.poster.title"), W / 2, 120);

    ctx.fillStyle = t.period;
    ctx.font = "400 28px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    ctx.fillText(_scorecard.period, W / 2, 170);

    // Hero: cache hit rate.
    ctx.fillStyle = t.hero;
    ctx.font = "800 160px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillText("⚡" + _scorecard.cacheHitRate + "%", W / 2, 360);

    ctx.fillStyle = t.tagline;
    ctx.font = "400 34px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    ctx.fillText(I18n.t("share.scorecard.poster.cacheLabel"), W / 2, 420);

    // Secondary metrics: cost + tokens.
    ctx.fillStyle = t.metric;
    ctx.font = "700 50px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillText(_scorecard.costStr, W / 2 - 160, 540);
    ctx.fillText(_scorecard.tokensStr, W / 2 + 160, 540);
    ctx.fillStyle = t.metricLabel;
    ctx.font = "400 26px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    ctx.fillText(I18n.t("share.scorecard.poster.costLabel"), W / 2 - 160, 580);
    ctx.fillText(I18n.t("share.scorecard.poster.tokensLabel"), W / 2 + 160, 580);

    // Golden line = live editor text (poster matches what gets posted).
    const line = (copy || "").trim() || _scorecardGoldenLine();
    ctx.fillStyle = t.golden;
    _drawAutoText(ctx, line, W / 2, 630, W - 120, 760 - 630);

    // QR + brand chip (gated: branded builds with no homepage show neither).
    const url = _shareUrl();
    if (url) {
      const qrSize = 230;
      const qrX = (W - qrSize) / 2;
      const qrY = 790;
      ctx.fillStyle = "#ffffff";
      _roundRect(ctx, qrX - 20, qrY - 20, qrSize + 40, qrSize + 40, 18);
      ctx.fill();
      _drawQrToCanvas(ctx, url, qrX, qrY, qrSize);

      ctx.fillStyle = t.brand;
      ctx.font = "600 30px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
      ctx.fillText(_brand.name, W / 2, qrY + qrSize + 60);
      ctx.fillStyle = t.scan;
      ctx.font = "400 24px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
      ctx.fillText(I18n.t("share.scorecard.poster.scan"), W / 2, qrY + qrSize + 98);
    } else {
      ctx.fillStyle = t.brand;
      ctx.font = "600 34px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
      ctx.fillText(_brand.name, W / 2, 920);
    }

    return canvas.toDataURL("image/png");
  }

  // Draws `text` centered at cx, fitting within (maxWidth × maxHeight) starting
  // at startY. Picks the largest font (from a descending ladder) whose wrapped
  // lines fit the height, honoring explicit "\n" breaks. Vertically centers.
  function _drawAutoText(ctx, text, cx, startY, maxWidth, maxHeight) {
    const sizes = [40, 36, 32, 28, 24, 20];
    let chosen = null;
    for (const size of sizes) {
      ctx.font = "500 " + size + "px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
      const lh = Math.round(size * 1.4);
      const lines = _wrapLines(ctx, text, maxWidth);
      if (lines.length * lh <= maxHeight || size === sizes[sizes.length - 1]) {
        chosen = { size, lh, lines };
        break;
      }
    }
    ctx.font = "500 " + chosen.size + "px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    const totalH = chosen.lines.length * chosen.lh;
    let y = startY + (maxHeight - totalH) / 2 + chosen.lh * 0.75;
    for (const line of chosen.lines) {
      ctx.fillText(line, cx, y);
      y += chosen.lh;
    }
  }

  // Wraps text into lines fitting maxWidth, honoring explicit "\n" breaks.
  function _wrapLines(ctx, text, maxWidth) {
    const out = [];
    for (const para of String(text).split("\n")) {
      let line = "";
      for (const ch of para) {
        if (ctx.measureText(line + ch).width > maxWidth && line) {
          out.push(line);
          line = ch;
        } else {
          line += ch;
        }
      }
      out.push(line);
    }
    return out;
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

  // Append the landing URL (when present) to a body of share text.
  function _withUrl(body) {
    const url = _shareUrl();
    return url ? `${body} ${url}`.trim() : body;
  }

  function _toWeibo(text) {
    const url = _shareUrl() || "";
    const share = "https://service.weibo.com/share/share.php?url=" +
      encodeURIComponent(url) + "&title=" + encodeURIComponent(text);
    window.open(share, "_blank", "noopener,noreferrer");
  }

  // ── Poster sharing helpers ────────────────────────────────────────────
  function _posterFilename() {
    return `${_brand.name.toLowerCase()}-${_scorecard ? "scorecard" : "share"}.png`;
  }

  function _downloadPoster(copy) {
    const a = document.createElement("a");
    a.href = _scorecard ? _buildScorecardPoster(copy) : _buildPoster(copy);
    a.download = _posterFilename();
    a.click();
  }

  function _saveDraft(text) {
    try { localStorage.setItem(DRAFT_KEY, text); } catch (_e) { /* quota, ignore */ }
  }
  function _loadDraft() {
    try { return localStorage.getItem(DRAFT_KEY) || ""; } catch (_e) { return ""; }
  }

  // ── Modal UI ──────────────────────────────────────────────────────────
  let _overlay = null;
  let _activePlatform = "weibo";

  const PLATFORMS = ["weibo", "xhs", "wechat", "bilibili"];

  function openModal() {
    // Tear down a stale overlay without clearing scorecard state (closeModal
    // nulls _scorecard, which openScorecard has just set).
    if (_overlay) { _overlay.remove(); _overlay = null; }

    const hasUrl = !!_shareUrl();
    const titleKey    = _scorecard ? "share.scorecard.modal.title"    : "share.modal.title";
    const subtitleKey = _scorecard ? "share.scorecard.modal.subtitle" : "share.modal.subtitle";

    _activePlatform = "weibo";

    const o = document.createElement("div");
    o.className = "share-overlay";

    const themeChips = THEME_ORDER.map((id) => {
      const th = THEMES[id];
      const on = id === _themeId() ? " is-active" : "";
      return '<button type="button" class="share-theme-chip' + on + '" data-theme="' + id + '"' +
        ' style="background:' + th.swatch + '" title="' + _esc(I18n.t(th.labelKey)) + '">' +
        '<span class="share-theme-name">' + _esc(I18n.t(th.labelKey)) + '</span></button>';
    }).join("");

    const platformTabs = PLATFORMS.map((p) => {
      const on = p === _activePlatform ? " is-active" : "";
      return '<button type="button" class="share-platform' + on + '" data-platform="' + p + '">' +
        _esc(I18n.t("share.platform." + p)) + '</button>';
    }).join("");

    o.innerHTML =
      '<div class="share-modal" role="dialog" aria-modal="true">' +
        '<button type="button" class="share-close" aria-label="Close">&times;</button>' +
        '<h3 class="share-title">' + _esc(I18n.t(titleKey, { brand: _brand.name })) + '</h3>' +
        '<p class="share-subtitle">' + _esc(I18n.t(subtitleKey)) + '</p>' +
        '<div class="share-body">' +
          '<div class="share-poster-wrap"><img class="share-poster-img" alt="poster"/></div>' +
          '<div class="share-controls">' +
            '<div class="share-theme-row">' +
              '<span class="share-row-label">' + _esc(I18n.t("share.theme.label")) + '</span>' +
              '<div class="share-theme-chips">' + themeChips + '</div>' +
            '</div>' +
            '<div class="share-platforms">' + platformTabs + '</div>' +
            '<div class="share-editor">' +
              '<div class="share-editor-head">' +
                '<span class="share-row-label">' + _esc(I18n.t("share.editor.label")) + '</span>' +
                '<button type="button" class="share-shuffle" data-act="shuffle">🎲 ' + _esc(I18n.t("share.action.shuffle")) + '</button>' +
              '</div>' +
              '<textarea class="share-text" rows="4"></textarea>' +
            '</div>' +
            '<div class="share-actions">' +
              '<button type="button" class="share-btn-primary" data-act="primary"></button>' +
              '<button type="button" class="share-btn-secondary" data-act="copytext">' + _esc(I18n.t("share.action.copyText")) + '</button>' +
              '<button type="button" class="share-btn-secondary" data-act="download">' + _esc(I18n.t("share.action.download")) + '</button>' +
              (hasUrl ? '<button type="button" class="share-btn-secondary" data-act="copylink">' + _esc(I18n.t("share.action.copyLink")) + '</button>' : '') +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(o);
    _overlay = o;

    const img = o.querySelector(".share-poster-img");
    const textarea = o.querySelector(".share-text");

    const renderPoster = () => {
      const copy = (textarea.value || "").trim();
      try { img.src = _scorecard ? _buildScorecardPoster(copy) : _buildPoster(copy); }
      catch (_e) { o.querySelector(".share-poster-wrap").style.display = "none"; }
    };

    // Seed the editor: prefer the user's last hand-edited draft (product mode
    // only — scorecard text carries live numbers and shouldn't be stale).
    const draft = _scorecard ? "" : _loadDraft();
    textarea.value = draft || _pickCopy(_activePlatform);
    renderPoster();

    textarea.addEventListener("input", () => {
      if (!_scorecard) _saveDraft(textarea.value);
      renderPoster();
    });

    const setActivePlatform = (p) => {
      _activePlatform = p;
      o.querySelectorAll(".share-platform").forEach((b) => {
        b.classList.toggle("is-active", b.getAttribute("data-platform") === p);
      });
      textarea.value = _pickCopy(p);
      if (!_scorecard) _saveDraft(textarea.value);
      _updatePrimaryLabel(o);
      renderPoster();
    };

    o.querySelectorAll(".share-platform").forEach((b) => {
      b.onclick = () => setActivePlatform(b.getAttribute("data-platform"));
    });

    o.querySelectorAll(".share-theme-chip").forEach((chip) => {
      chip.onclick = () => {
        _setTheme(chip.getAttribute("data-theme"));
        o.querySelectorAll(".share-theme-chip").forEach((c) => {
          c.classList.toggle("is-active", c === chip);
        });
        renderPoster();
      };
    });

    const close = () => closeModal();
    o.querySelector(".share-close").onclick = close;
    o.addEventListener("click", (e) => { if (e.target === o) close(); });

    o.querySelectorAll("[data-act]").forEach((btn) => {
      const act = btn.getAttribute("data-act");
      if (act === "shuffle") {
        btn.onclick = () => {
          textarea.value = _pickCopy(_activePlatform, textarea.value.trim());
          if (!_scorecard) _saveDraft(textarea.value);
          renderPoster();
        };
      } else {
        btn.onclick = () => _handleAction(act, textarea);
      }
    });

    _updatePrimaryLabel(o);
    requestAnimationFrame(() => o.classList.add("open"));
  }

  // Primary button label/behavior depends on the active platform: Weibo gets
  // a real one-click jump; image-first platforms (xhs/wechat/bilibili) get
  // "download poster + copy text".
  function _updatePrimaryLabel(o) {
    const btn = o.querySelector('[data-act="primary"]');
    if (!btn) return;
    btn.textContent = _activePlatform === "weibo"
      ? I18n.t("share.action.toWeibo")
      : I18n.t("share.action.downloadAndCopy");
  }

  function _handleAction(act, textarea) {
    const text = (textarea && textarea.value || "").trim();
    switch (act) {
      case "copytext":
        _copy(_withUrl(text));
        break;
      case "download":
        _downloadPoster(text);
        break;
      case "copylink":
        _copy(_shareUrl());
        break;
      case "primary":
        _primaryShare(text);
        break;
    }
  }

  function _primaryShare(text) {
    switch (_activePlatform) {
      case "weibo":
        _toWeibo(text);
        break;
      default:
        // Image-first platforms (xhs / wechat / bilibili): one button that
        // downloads the poster AND copies the text, then guides the user.
        _downloadPoster(text);
        _copy(_withUrl(text));
        Modal.toast(I18n.t("share.hint." + _activePlatform), "info");
        break;
    }
  }

  function closeModal() {
    if (!_overlay) return;
    const o = _overlay;
    _overlay = null;
    _scorecard = null;
    o.classList.remove("open");
    setTimeout(() => o.remove(), 200);
  }

  // ── Scorecard entry (B-line) ──────────────────────────────────────────
  // Opens the share modal in "scorecard" mode with live billing numbers.
  // stats: { period, cacheHitRate, costStr, tokensStr, requests }
  function openScorecard(stats) {
    _scorecard = stats || null;
    openModal();
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

  return { init, openModal, openScorecard, closeModal, maybePromptOnComplete };
})();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => Share.init());
} else {
  Share.init();
}
