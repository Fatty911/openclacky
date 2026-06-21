// ── Share · store — brand source, scorecard state, frequency cap, telemetry
//
// Owns the share feature's data: the brand identity (hydrated from
// /api/brand/status), the live scorecard stats + selected period, the
// success-count / cooldown frequency cap (localStorage), and the telemetry
// beacon. It never renders.
//
// White-label safety lives here: a branded build NEVER falls back to
// openclacky.com — the homepage/QR url is simply null when unset.
//
// `Share` stays the single public facade.
//
// Depends on: Clacky.ext.
// ───────────────────────────────────────────────────────────────────────────

const ShareStore = (() => {
  const DEFAULT_NAME     = "OpenClacky";
  const DEFAULT_HOMEPAGE = "https://www.openclacky.com/";

  const COUNT_KEY    = "clacky-share-success-count";
  const COOLDOWN_KEY = "clacky-share-cooldown-until";
  const COOLDOWN_MS  = 7 * 24 * 60 * 60 * 1000;
  const PROMPT_AT    = [1, 5];

  let _brand      = { name: DEFAULT_NAME, homepageUrl: DEFAULT_HOMEPAGE, logoUrl: null };
  let _scorecard  = null;
  let _scorePeriod = null;

  const _listeners = {};

  function _on(event, handler) {
    (_listeners[event] ||= []).push(handler);
    return () => {
      const list = _listeners[event];
      const i = list ? list.indexOf(handler) : -1;
      if (i >= 0) list.splice(i, 1);
    };
  }

  function _emit(event, payload) {
    (_listeners[event] || []).forEach((h) => h(payload));
    if (window.Clacky && Clacky.ext) Clacky.ext.emit(event, payload);
  }

  const state = {
    get brand()       { return _brand; },
    get scorecard()   { return _scorecard; },
    get scorePeriod() { return _scorePeriod; },
    set scorePeriod(p) { _scorePeriod = p; },
    shareUrl()        { return _brand.homepageUrl; },

    /** Stats for the selected period, falling back to flat fields. */
    curStats() {
      if (_scorecard && _scorecard.periods && _scorePeriod && _scorecard.periods[_scorePeriod]) {
        return _scorecard.periods[_scorePeriod];
      }
      return _scorecard;
    },
  };

  async function _hydrateBrand() {
    try {
      const res = await fetch("/api/brand/status");
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.branded) {
        _brand = {
          name:        (data.product_name || "").trim() || DEFAULT_NAME,
          homepageUrl: (data.homepage_url || "").trim() || null,
          logoUrl:     (data.logo_url || "").trim() || null
        };
        _emit("share:brandChanged", _brand);
      }
    } catch (_e) { /* keep defaults */ }
  }

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

  const Share = {
    on: _on,
    state,
    PROMPT_AT,

    hydrateBrand: _hydrateBrand,

    /** Enter scorecard mode with live stats; picks the default period. */
    setScorecard(stats) {
      _scorecard   = stats || null;
      _scorePeriod = _scorecard
        ? (_scorecard.defaultPeriod && _scorecard.periods && _scorecard.periods[_scorecard.defaultPeriod]
            ? _scorecard.defaultPeriod
            : (_scorecard.periods ? Object.keys(_scorecard.periods)[0] : null))
        : null;
      _emit("share:scorecardChanged", { scorecard: _scorecard, period: _scorePeriod });
    },

    /** Merge a late-arriving period's stats and notify the view. */
    addScorecardPeriod(key, stats) {
      if (!_scorecard) return false;
      if (!_scorecard.periods) _scorecard.periods = {};
      _scorecard.periods[key] = stats;
      _emit("share:scorecardPeriodAdded", { key, stats });
      return true;
    },

    clearScorecard() {
      _scorecard   = null;
      _scorePeriod = null;
      _emit("share:scorecardChanged", { scorecard: null, period: null });
    },

    /** Bump success count and decide whether to auto-prompt; starts cooldown. */
    consumeSuccess() {
      const n = _bumpSuccessCount();
      if (_inCooldown())          return { prompt: false };
      if (!PROMPT_AT.includes(n)) return { prompt: false };
      _startCooldown();
      return { prompt: true, count: n };
    },

    telemetry(event, extra) {
      if (typeof fetch === "undefined") return;
      const body = JSON.stringify({ event, extra: extra || {} });
      fetch("/api/telemetry", { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
    },
  };

  return Share;
})();

const Share = ShareStore;
