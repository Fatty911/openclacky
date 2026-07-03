// ── Extensions · store — data, state, network for the extension marketplace ─
//
// The store is the single source of truth for the public extension catalog. It
// owns state, talks to the local server (which proxies the platform's public
// /api/v1/extensions endpoint), and emits events so the view re-renders. It
// NEVER touches the DOM directly.
//
// Extension archives are NOT downloadable from here — extensions ship inside
// license-gated brand packages (path B distribution). This panel is a
// read-only browse/search catalog of metadata only.
//
// Two event channels (same convention as the skills store):
//   1. Internal bus (Extensions.on / _emit) — always live; the core view
//      subscribes here so the panel keeps rendering under ?pure=true.
//   2. Clacky.ext.emit(...) — extension bus; silenced in pure mode.
//
// Depends on: I18n, global $ / escapeHtml helpers, Clacky.ext (core/ext.js)
// ───────────────────────────────────────────────────────────────────────────

const ExtensionsStore = (() => {
  // ── State (single source of truth) ─────────────────────────────────────
  let _extensions = [];        // [{ id, name, name_zh, description, ..., units }]
  let _query      = "";        // current search text
  let _sort       = "newest";  // "newest" | "updated" | "downloads"
  let _loading    = false;
  let _error      = null;      // soft warning when the store is unreachable

  // ── Internal event bus ──────────────────────────────────────────────────
  const _listeners = {};       // event => [handler]

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

  // ── Read-only accessors used by the view ────────────────────────────────
  const state = {
    get extensions() { return _extensions; },
    get query()      { return _query; },
    get sort()       { return _sort; },
    get loading()    { return _loading; },
    get error()      { return _error; },
  };

  const Extensions = {
    on: _on,
    state,

    /** Fetch the catalog from the server for the current query + sort. */
    async load() {
      _loading = true;
      _error   = null;
      _emit("extensions:loading");
      try {
        const params = new URLSearchParams();
        if (_query) params.set("q", _query);
        if (_sort)  params.set("sort", _sort);
        const qs   = params.toString();
        const res  = await fetch("/api/store/extensions" + (qs ? "?" + qs : ""));
        const data = await res.json();
        _extensions = data.extensions || [];
        _error      = data.warning || null;
        _loading    = false;
        _emit("extensions:changed", { extensions: _extensions, warning: _error });
      } catch (e) {
        console.error("[Extensions] load failed", e);
        _extensions = [];
        _error      = I18n.t("extensions.loadFailed");
        _loading    = false;
        _emit("extensions:error", { network: true });
      } finally {
        _loading = false;
      }
    },

    /** Set the search text and reload. */
    setQuery(query) {
      _query = (query || "").trim();
      return Extensions.load();
    },

    /** Set the sort order and reload. */
    setSort(sort) {
      _sort = sort || "newest";
      return Extensions.load();
    },
  };

  return Extensions;
})();

const Extensions = ExtensionsStore;
Clacky.Extensions = Extensions;
