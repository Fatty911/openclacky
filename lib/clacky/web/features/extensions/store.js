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
  let _extensions      = [];        // [{ id, name, name_zh, description, ..., units }]
  let _allExtensions   = [];        // unfiltered result from server
  let _query           = "";        // current search text
  let _sort            = "newest";  // "newest" | "updated" | "downloads"
  let _filterInstalled = false;     // when true, show only installed extensions
  let _loading    = false;
  let _error      = null;      // soft warning when the store is unreachable
  let _detail     = null;      // currently opened extension detail, or null
  let _detailLoading = false;
  let _detailError   = null;

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
    get filterInstalled() { return _filterInstalled; },
    get loading()    { return _loading; },
    get error()      { return _error; },
    get detail()        { return _detail; },
    get detailLoading() { return _detailLoading; },
    get detailError()   { return _detailError; },
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
        _allExtensions = data.extensions || [];
        _extensions    = _filterInstalled ? _allExtensions.filter(e => e.installed) : _allExtensions;
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

    /** Toggle the "installed only" filter (client-side, no new network request). */
    setFilterInstalled(onlyInstalled) {
      _filterInstalled = !!onlyInstalled;
      _extensions = _filterInstalled ? _allExtensions.filter(e => e.installed) : _allExtensions;
      _emit("extensions:changed", { extensions: _extensions, warning: _error });
    },

    /** Open the detail view for one extension (fetches contributes + versions). */
    async loadDetail(id) {
      if (!id) return;
      _detail        = null;
      _detailLoading = true;
      _detailError   = null;
      _emit("extensions:detail");
      try {
        const res  = await fetch("/api/store/extension?id=" + encodeURIComponent(id));
        const data = await res.json();
        if (res.ok && data.ok && data.extension) {
          _detail      = data.extension;
          _detailError = null;
        } else {
          _detail      = null;
          _detailError = data.error || I18n.t("extensions.loadFailed");
        }
      } catch (e) {
        console.error("[Extensions] loadDetail failed", e);
        _detail      = null;
        _detailError = I18n.t("extensions.loadFailed");
      } finally {
        _detailLoading = false;
        _emit("extensions:detail");
      }
    },

    /** Close the detail view. */
    closeDetail() {
      _detail        = null;
      _detailLoading = false;
      _detailError   = null;
      _emit("extensions:detail");
    },

    /** Disable/enable an installed extension, then refresh the open detail. */
    async setEnabled(id, enabled) {
      if (!id) return;
      const path = enabled ? "/api/store/extension/enable" : "/api/store/extension/disable";
      try {
        const res = await fetch(path, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ id }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "toggle failed");
        await Extensions.loadDetail(id);
        Extensions.load();
      } catch (e) {
        console.error("[Extensions] setEnabled failed", e);
        _detailError = e.message;
        _emit("extensions:detail");
      }
    },

    /** Install a marketplace extension by fetching its download_url then posting to the local server. */
    async install(id) {
      if (!id) return;
      try {
        const detailRes  = await fetch("/api/store/extension?id=" + encodeURIComponent(id));
        const detailData = await detailRes.json();
        if (!detailRes.ok || !detailData.ok) throw new Error(detailData.error || "fetch detail failed");
        const ext          = detailData.extension;
        const download_url = ext.download_url;
        if (!download_url) throw new Error("No download URL available");
        const res = await fetch("/api/store/extension/install", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ download_url, name: ext.name }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "install failed");
        await Extensions.loadDetail(id);
      } catch (e) {
        console.error("[Extensions] install failed", e);
        _detailError = e.message;
        _emit("extensions:detail");
      }
    },

    /** Remove an installed extension, then return to the list. */
    async uninstall(id) {
      if (!id) return;
      try {
        const res = await fetch("/api/store/extension", {
          method:  "DELETE",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ id }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "uninstall failed");
        await Extensions.loadDetail(id);
      } catch (e) {
        console.error("[Extensions] uninstall failed", e);
        _detailError = e.message;
        _emit("extensions:detail");
      }
    },
  };

  return Extensions;
})();

const Extensions = ExtensionsStore;
Clacky.Extensions = Extensions;
