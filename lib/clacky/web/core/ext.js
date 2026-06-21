// ── Clacky.ext — WebUI extension registry ─────────────────────────────────
//
// The single, controlled entry point through which user/AI-authored
// extensions (loaded from ~/.clacky/webui_ext/) hook into the WebUI.
//
// Three capabilities (the whole contract an extension author must learn):
//   Clacky.ext.api.register(name, fn)        — register a data source
//   Clacky.ext.subscribe(event, handler)     — listen to store events (read-only)
//   Clacky.ext.ui.mount(slot, renderFn)      — inject UI into a named slot
//
// Safety guarantees enforced here (the "constitution"):
//   - Every extension callback is wrapped in try/catch. A throwing extension is
//     contained: its slot degrades to a placeholder marked
//     data-ext-status="crashed"; it never takes down the host or sibling slots.
//   - In pure mode (?pure=true), the registry becomes a no-op: register/
//     subscribe/mount do nothing, so no extension code can affect the page.
//   - Extensions reach the host ONLY through this object. The enable/disable
//     and safe-mode controls live in the host frame, never inside an extension.
//
// Depends on: nothing (loads right after utils.js).
// ───────────────────────────────────────────────────────────────────────────

window.Clacky = window.Clacky || {};

Clacky.ext = (() => {
  // Pure mode: detect ?pure=true once. When on, all registration is a no-op and
  // the host must not load any webui_ext scripts (handled server-side / in the
  // loader). This is the ultimate escape hatch back to a clean official UI.
  const PURE = (() => {
    try {
      return new URLSearchParams(window.location.search).get("pure") === "true";
    } catch (_e) {
      return false;
    }
  })();

  const _dataSources = {};            // name => fn
  const _subscribers = {};            // event => [handler]
  const _slotRenderers = {};          // slot => [{ fn, extId }]
  let   _currentExtId = null;         // set while an extension file is loading

  // Wrap any extension-provided callback so a throw is contained, logged, and
  // attributed to the extension that registered it.
  function _guard(fn, label, extId) {
    return (...args) => {
      try {
        return fn(...args);
      } catch (err) {
        console.error(`[Clacky.ext] extension "${extId || "?"}" failed in ${label}:`, err);
        return undefined;
      }
    };
  }

  // Bracket an extension's synchronous evaluation so registrations made during
  // it are attributed to `extId`. The host emits _extBegin before the
  // extension's <script src> and _extEnd right after. In pure mode these are
  // no-ops (and the host does not emit extension scripts at all).
  function _extBegin(extId) {
    if (PURE) return;
    _currentExtId = extId;
  }

  function _extEnd() {
    _currentExtId = null;
  }

  const api = {
    // Register a named data source. Host/extensions can later resolve it.
    register(name, fn) {
      if (PURE || typeof fn !== "function") return;
      _dataSources[name] = _guard(fn, `api.register(${name})`, _currentExtId);
    },
    // Resolve a registered data source by name; undefined if absent.
    resolve(name) {
      return _dataSources[name];
    },
  };

  // Subscribe to a store event. Read-only: handlers can observe, never mutate
  // core logic. Returns an unsubscribe function.
  function subscribe(event, handler) {
    if (PURE || typeof handler !== "function") return () => {};
    const wrapped = _guard(handler, `subscribe(${event})`, _currentExtId);
    (_subscribers[event] ||= []).push(wrapped);
    return () => {
      const list = _subscribers[event];
      if (!list) return;
      const i = list.indexOf(wrapped);
      if (i >= 0) list.splice(i, 1);
    };
  }

  // Emit a store event to all subscribers. Called by store-layer code (host),
  // never by extensions. A throwing subscriber is already guarded above.
  function emit(event, payload) {
    const list = _subscribers[event];
    if (!list) return;
    list.forEach((h) => h(payload));
  }

  const ui = {
    // Register a renderer for a named slot. renderFn(ctx) -> Node | string | null.
    mount(slot, renderFn) {
      if (PURE || typeof renderFn !== "function") return;
      (_slotRenderers[slot] ||= []).push({
        fn: _guard(renderFn, `ui.mount(${slot})`, _currentExtId),
        extId: _currentExtId,
      });
    },
  };

  // Render every extension registered for `slot` into `container`.
  // Called by the host's view layer wherever it exposes a slot. Each renderer
  // is isolated: if one throws (guarded -> returns undefined) or yields nothing,
  // a degraded placeholder marked data-ext-status="crashed" is shown for it,
  // and sibling renderers / the rest of the page are unaffected.
  function renderSlot(slot, container, ctx) {
    if (!container) return;
    const renderers = _slotRenderers[slot];
    if (!renderers || renderers.length === 0) return;

    renderers.forEach(({ fn, extId }) => {
      let node;
      let crashed = false;
      try {
        node = fn(ctx || {});
        if (node === undefined) crashed = true; // guard swallowed a throw
      } catch (_e) {
        crashed = true; // defensive: should already be guarded
      }

      if (crashed) {
        const ph = document.createElement("div");
        ph.setAttribute("data-ext-status", "crashed");
        ph.setAttribute("data-ext-id", extId || "");
        ph.className = "ext-slot-crashed";
        ph.textContent = "Extension failed to render.";
        container.appendChild(ph);
        return;
      }

      if (node == null) return; // nothing to render is valid
      if (typeof node === "string") {
        const wrap = document.createElement("div");
        wrap.setAttribute("data-ext-id", extId || "");
        wrap.innerHTML = node;
        container.appendChild(wrap);
      } else {
        container.appendChild(node);
      }
    });
  }

  // List slot names that currently have at least one renderer (host/debug use).
  function slots() {
    return Object.keys(_slotRenderers).filter((s) => _slotRenderers[s].length > 0);
  }

  return {
    get pure() { return PURE; },
    api,
    ui,
    subscribe,
    emit,
    renderSlot,
    slots,
    _extBegin,  // used by the loader; not part of the public extension API
    _extEnd,    // used by the loader; not part of the public extension API
  };
})();
