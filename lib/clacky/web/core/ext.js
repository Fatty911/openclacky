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
  const _slotRenderers = {};          // slot => [{ fn, extId, agents, panel, order, tab }]
  let   _currentExtId = null;         // set while an extension file is loading

  // Slots that render as a tabbed container instead of a vertical stack: each
  // renderer becomes one tab (chrome drawn by the host), and only the active
  // tab's body is shown. Renderers in these slots must carry opts.tab.
  const TABBED_SLOTS = { "session.aside": true };
  // slot => active tab id (remembered across re-renders within a page load).
  const _activeTab = {};

  // Per-extension/panel agent scoping declared at load time:
  //   _extAgents[extId]  = ["coding", ...]   (from <script data-agent=...>, may be multiple)
  //   _panelAgents[panel] = ["coding", ...]  (agents whose profile.yml references the panel)
  // Resolved by the host before the extension scripts run (see loader markers).
  const _extAgents = {};
  const _panelAgents = {};
  let   _currentPanel = null;         // set while an official panel file is loading

  // Current session context, kept in sync by the host on every session switch.
  // Slots are (re)rendered against this so an extension/panel only appears for
  // the agent profiles it was scoped to.
  const context = { agentProfile: null };

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
  //
  // `agents` scopes a single-agent extension (from agents/<name>/webui/): a list
  // of agent profile names it should appear for. `panel` marks an official
  // panel (from _panels/<id>/) whose agent scope is resolved separately via
  // registerPanelAgents. Either may be omitted for a global extension.
  function _extBegin(extId, agents, panel) {
    if (PURE) return;
    _currentExtId = extId;
    if (Array.isArray(agents) && agents.length) _extAgents[extId] = agents;
    if (panel) _currentPanel = panel;
  }

  function _extEnd() {
    _currentExtId = null;
    _currentPanel = null;
  }

  // Record which agent profiles reference an official panel (host computes this
  // from each agent's profile.yml `panels:` declaration). Called once at load.
  function registerPanelAgents(map) {
    if (PURE || !map) return;
    Object.assign(_panelAgents, map);
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
    //
    // opts.agents — restrict to these agent profile names (default: all agents).
    //   For panels, scope is taken from the panel's registerPanelAgents map and
    //   merged with any explicit opts.agents.
    // opts.order — vertical sort weight when several renderers share one slot
    //   (lower renders first). Default 100; ties keep registration order.
    // opts.tab — { id, label, badge? } required for tabbed slots: marks this
    //   renderer as one tab in the slot's tab bar.
    mount(slot, renderFn, opts) {
      if (PURE || typeof renderFn !== "function") return;
      const explicit = opts && Array.isArray(opts.agents) ? opts.agents : null;
      const panel    = (opts && opts.panel) || _currentPanel || null;
      const scoped   = explicit || _extAgents[_currentExtId] || null;
      const order    = opts && Number.isFinite(opts.order) ? opts.order : 100;
      const tab      = (opts && opts.tab) || null;
      (_slotRenderers[slot] ||= []).push({
        fn: _guard(renderFn, `ui.mount(${slot})`, _currentExtId),
        extId: _currentExtId,
        agents: scoped,   // explicit/per-extension agent list, or null = global
        panel,            // official-panel id, or null
        order,
        tab,              // { id, label, badge? } for tabbed slots, else null
      });
    },

    // Register a host-owned renderer (not attributed to any extension). Used for
    // built-in tabs that must appear for every session regardless of agent
    // scope (e.g. the Files tab). Bypasses PURE so the official UI keeps working
    // in safe mode. agents=null => visible everywhere.
    mountBuiltin(slot, renderFn, opts) {
      if (typeof renderFn !== "function") return;
      const order = opts && Number.isFinite(opts.order) ? opts.order : 100;
      const tab   = (opts && opts.tab) || null;
      (_slotRenderers[slot] ||= []).push({
        fn: _guard(renderFn, `ui.mountBuiltin(${slot})`, "host"),
        extId: "host",
        agents: null,
        panel: null,
        order,
        tab,
      });
    },
  };

  // Decide whether a renderer is visible under the current agent profile.
  // null agents AND null panel => global (always visible). Otherwise the
  // current profile must be in the renderer's agent list, or in the set of
  // agents that reference its panel.
  function _visibleFor(entry, profile) {
    if (!entry.agents && !entry.panel) return true;
    if (entry.agents && entry.agents.includes(profile)) return true;
    if (entry.panel && (_panelAgents[entry.panel] || []).includes(profile)) return true;
    return false;
  }

  // Render every extension registered for `slot` into `container`, scoped to the
  // current agent profile. Called by the host's view layer wherever it exposes a
  // slot, and re-called on session switch (the container is cleared first so a
  // previous agent's panels don't linger). Each renderer is isolated: if one
  // throws (guarded -> returns undefined) or yields nothing, a degraded
  // placeholder marked data-ext-status="crashed" is shown for it, and sibling
  // renderers / the rest of the page are unaffected.
  function renderSlot(slot, container, ctx) {
    if (!container) return;
    if (TABBED_SLOTS[slot]) {
      renderTabbedSlot(slot, container, ctx);
      return;
    }
    container.replaceChildren();  // clear stale render from a previous agent
    const renderers = _slotRenderers[slot];
    if (!renderers || renderers.length === 0) return;

    const profile = (ctx && ctx.agentProfile) || context.agentProfile;
    const renderCtx = Object.assign({}, context, ctx || {});
    // Lower order renders first; sort is stable so equal orders keep
    // registration order. slice() avoids mutating the registry.
    const ordered = renderers.slice().sort((a, b) => a.order - b.order);
    ordered.forEach((entry) => {
      if (!_visibleFor(entry, profile)) return;
      const { fn, extId } = entry;
      let node;
      let crashed = false;
      try {
        node = fn(renderCtx);
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

  // Render a tabbed slot: a tab bar across the top, one body shown at a time.
  // Each visible renderer (carrying entry.tab) becomes a tab; its body is
  // rendered lazily on first activation and cached for the lifetime of this
  // render pass. The host chrome (resize / collapse) lives in the surrounding
  // DOM and is not touched here. Re-rendered wholesale on every session switch.
  function renderTabbedSlot(slot, container, ctx) {
    container.replaceChildren();
    const profile = (ctx && ctx.agentProfile) || context.agentProfile;
    const renderCtx = Object.assign({}, context, ctx || {});

    const renderers = (_slotRenderers[slot] || [])
      .slice()
      .sort((a, b) => a.order - b.order)
      .filter((e) => e.tab && _visibleFor(e, profile));

    if (renderers.length === 0) return; // empty slot → host CSS collapses it

    const tabBar = document.createElement("div");
    tabBar.className = "aside-tabs";
    const bodies = document.createElement("div");
    bodies.className = "aside-bodies";

    // Restore previously active tab if still present, else first tab.
    const ids = renderers.map((e) => e.tab.id);
    let active = _activeTab[slot];
    if (!active || !ids.includes(active)) active = ids[0];

    const tabBtns = {};
    const bodyEls = {};
    const rendered = {};

    function activate(id) {
      _activeTab[slot] = id;
      Object.keys(tabBtns).forEach((k) => tabBtns[k].classList.toggle("active", k === id));
      Object.keys(bodyEls).forEach((k) => bodyEls[k].classList.toggle("active", k === id));
      if (!rendered[id]) {
        rendered[id] = true;
        const entry = renderers.find((e) => e.tab.id === id);
        const body = bodyEls[id];
        const localCtx = Object.assign({}, renderCtx, {
          setBadge: (n) => _setTabBadge(tabBtns[id], n),
        });
        let node, crashed = false;
        try {
          node = entry.fn(localCtx);
          if (node === undefined) crashed = true;
        } catch (_e) { crashed = true; }
        if (crashed) {
          const ph = document.createElement("div");
          ph.className = "ext-slot-crashed";
          ph.textContent = "Extension failed to render.";
          body.appendChild(ph);
        } else if (node != null) {
          if (typeof node === "string") body.innerHTML = node;
          else body.appendChild(node);
        }
      }
    }

    renderers.forEach((entry) => {
      const id = entry.tab.id;
      const btn = document.createElement("button");
      btn.className = "aside-tab";
      btn.type = "button";
      btn.setAttribute("data-tab", id);
      const label = document.createElement("span");
      label.textContent = (typeof entry.tab.label === "function" ? entry.tab.label() : entry.tab.label) || id;
      btn.appendChild(label);
      if (entry.tab.badge != null) _setTabBadge(btn, entry.tab.badge);
      btn.addEventListener("click", () => activate(id));
      tabBtns[id] = btn;
      tabBar.appendChild(btn);

      const body = document.createElement("div");
      body.className = "aside-panel";
      body.setAttribute("data-panel", id);
      bodyEls[id] = body;
      bodies.appendChild(body);
    });

    container.appendChild(tabBar);
    container.appendChild(bodies);
    activate(active);
  }

  // Set or clear a tab's badge pill. n == null/0 removes it.
  function _setTabBadge(btn, n) {
    if (!btn) return;
    let badge = btn.querySelector(".aside-tab-badge");
    if (n == null || n === 0 || n === "") {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "aside-tab-badge";
      btn.appendChild(badge);
    }
    badge.textContent = String(n);
  }

  // List slot names that currently have at least one renderer (host/debug use).
  function slots() {
    return Object.keys(_slotRenderers).filter((s) => _slotRenderers[s].length > 0);
  }

  // Update the current session context (host calls this on every session
  // switch) and re-render all slots so panels match the new agent profile.
  function setContext(next) {
    Object.assign(context, next || {});
    refreshSlots();
  }

  // Re-render every named slot present in the DOM against the current context.
  // Idempotent: each slot's container is cleared before re-rendering.
  function refreshSlots() {
    if (PURE) return;
    document.querySelectorAll("[data-slot]").forEach((el) => {
      renderSlot(el.getAttribute("data-slot"), el);
    });
  }

  return {
    get pure() { return PURE; },
    context,
    setContext,
    refreshSlots,
    registerPanelAgents,
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
