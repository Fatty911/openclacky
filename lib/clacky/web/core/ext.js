// ── Clacky.ext — WebUI extension registry ─────────────────────────────────
//
// The single, controlled entry point through which extensions declared
// in an ext.yml container hook into the WebUI.
//
// Three capabilities (the whole contract an extension author must learn):
//   Clacky.ext.api.register(name, fn)        — register a data source
//   Clacky.ext.subscribe(event, handler)     — listen to store events (read-only)
//   Clacky.ext.ui.mount(slot, spec, opts)    — inject UI into a named slot
//
//   `spec` is either a render function or { create?, render }. On per-session
//   slots (session.aside/banner/composer), providing `create(ctx)` gives you
//   one runtime per sessionId, isolated across sessions and disposed only
//   when the session leaves the sidebar.
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
  // Pure mode: detect ?pure=true once. When on, all registration is a no-op
  // and the host must not inject any extension scripts (handled server-side).
  // This is the ultimate escape hatch back to a clean official UI.
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
  const _workspaces = {};             // id => { id, title, render, extId }
  let   _currentExtId = null;         // set while an extension file is loading

  // Slots that render as a tabbed container instead of a vertical stack: each
  // renderer becomes one tab (chrome drawn by the host), and only the active
  // tab's body is shown. Renderers in these slots must carry opts.tab.
  const TABBED_SLOTS = { "session.aside": true };
  // slot => active tab id (remembered across re-renders within a page load).
  const _activeTab = {};

  // Slots that follow the current session's agent scope. A mount into any
  // of these, made from inside a panel file, is confined to that panel's
  // agents (via _currentPanel). Every other slot — sidebar, header, main
  // workspace — is treated as global chrome: mounts there always show,
  // regardless of which panel file happened to be loading. This is what
  // separates "session UI" from "app chrome" and it is the ONLY place
  // that distinction lives.
  const SESSION_SCOPED_SLOTS = {
    "session.banner": true,
    "session.composer": true,
    "session.aside": true,
    "settings.tabs": true,
    "settings.body": true,
  };

  // Named slots the host renders. Extensions mounting into any other name
  // will silently do nothing — we warn once per bad name to catch typos
  // like "sidebar-nav.top" or "session.aisde" during development.
  const KNOWN_SLOTS = {
    "header.left": true,
    "header.right": true,
    "sidebar.nav.top": true,
    "sidebar.nav": true,
    "sidebar.nav.bottom": true,
    "sidebar.footer": true,
    "main.workspace": true,
    "session.banner": true,
    "session.composer": true,
    "session.aside": true,
    "settings.tabs": true,
    "settings.body": true,
  };
  const _warnedUnknownSlots = {};

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

  // Warn once per unknown slot so a typo is loud but the log stays finite.
  function _warnUnknownSlot(slot, label) {
    if (KNOWN_SLOTS[slot] || _warnedUnknownSlots[slot]) return;
    _warnedUnknownSlots[slot] = true;
    const known = Object.keys(KNOWN_SLOTS).join(", ");
    console.warn(
      `[Clacky.ext] unknown slot ${JSON.stringify(slot)} in ${label}. ` +
      `Nothing will render. Known slots: ${known}`
    );
  }

  // Slots whose renderer represents "the current session's copy" of some UI
  // (a tabbed panel body, a session banner, a session-composer button). Mounts
  // to these slots may declare `create(ctx)` and get one runtime per session,
  // isolated from every other session and torn down only when the session
  // itself leaves the sidebar.
  const PER_SESSION_SLOTS = {
    "session.aside": true,
    "session.banner": true,
    "session.composer": true,
  };

  // sessionId => Map<mountKey, runtime>. Populated lazily on first render.
  const _sessionRuntimes = new Map();
  // sessionId => Map<mountKey, teardownFn|null>. Cleared before every rerender.
  const _viewTeardowns = new Map();

  // Deterministic key for a renderer within a session: same slot + extId + tab
  // id always resolves to the same runtime for a given session.
  function _mountKey(slot, entry) {
    const tabId = entry.tab && entry.tab.id ? entry.tab.id : "_";
    return `${slot}::${entry.extId || "?"}::${tabId}`;
  }

  // Normalize a mount registration. Accepts either a plain function (render
  // only) or an object { create?, render }. Anything else is rejected with a
  // console warning to catch typos early.
  function _register(slot, spec, opts, extId, extra) {
    let create = null;
    let render;
    if (typeof spec === "function") {
      render = spec;
    } else if (spec && typeof spec === "object" && typeof spec.render === "function") {
      render = spec.render;
      if (typeof spec.create === "function") create = spec.create;
    } else {
      console.warn(
        `[Clacky.ext] ui.mount(${JSON.stringify(slot)}) needs a render function ` +
        `or { create?, render } object. Got: ${typeof spec}`
      );
      return;
    }

    const isBuiltin = !!(extra && extra.builtin);
    const explicit  = opts && Array.isArray(opts.agents) ? opts.agents : null;
    const panel     = (!isBuiltin && SESSION_SCOPED_SLOTS[slot]) ? _currentPanel : null;
    const scoped    = isBuiltin ? null : (explicit || _extAgents[extId] || null);
    const order     = opts && Number.isFinite(opts.order) ? opts.order : 100;
    const tab       = (opts && opts.tab) || null;
    const workspace = (opts && typeof opts.workspace === "string") ? opts.workspace : null;

    const label = `ui.mount(${slot})`;
    (_slotRenderers[slot] ||= []).push({
      render:  _guard(render, label, extId),
      create:  create ? _guard(create, `${label}#create`, extId) : null,
      extId,
      agents:  scoped,
      panel,
      order,
      tab,
      workspace,
    });
  }


  // extension's <script src> and _extEnd right after. In pure mode these are
  // no-ops (and the host does not emit extension scripts at all).
  //
  // `agents` scopes a single-agent extension (from user agents/<name>/webui/):
  // a list of agent profile names it should appear for. `panel` marks a panel
  // whose agent scope is resolved separately via registerPanelAgents. Either
  // may be omitted for a global extension.
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
    // Scope rules (automatic — you never spell them out):
    //   • Mounts to session/settings slots inherit the current panel's agent
    //     scope, so a `session.aside` tab written next to a designer panel
    //     only shows when the user is on the designer agent.
    //   • Mounts to every other slot (sidebar.*, header.*, main.workspace)
    //     are global app chrome — they show regardless of panel/agent.
    //
    // opts.agents — restrict to these agent profile names, overriding the
    //   defaults above. Rarely needed.
    // Mount UI into a named slot. `spec` is either:
    //   • a function (ctx) => Node|string|null       — plain render, no state
    //   • an object { create?, render }              — render + optional
    //     per-session runtime bound to `create`
    //
    // If the slot is per-session (session.aside etc.) AND `create` is present,
    // the host allocates one runtime per sessionId — `create(ctx)` runs the
    // first time this session shows the tab, `render(container, ctx, runtime)`
    // runs every time the tab becomes visible with a fresh empty container,
    // and `runtime.dispose()` runs when the session leaves the sidebar. State
    // set up in `create` (media recorders, timers, subscriptions, buffers) is
    // therefore isolated per session and survives tab teardown.
    //
    // For non-per-session slots or specs without `create`, the mount is a
    // pure global renderer — one call per (re)render.
    //
    // opts.tab   — { id, label, badge? } required for tabbed slots.
    // opts.order — vertical sort weight (lower first). Default 100.
    // opts.workspace — id of a registerWorkspace() workspace this mount opens;
    //   the host stamps it on the mount so the Router highlights this item
    //   while that workspace is active. Use on sidebar.nav.* items.
    // opts.agents — override the automatic agent scope.
    mount(slot, spec, opts) {
      if (PURE || spec == null) return;
      _warnUnknownSlot(slot, `ui.mount(${_currentExtId || "?"})`);
      _register(slot, spec, opts, _currentExtId);
    },

    // Host-owned mount: identical to `mount` but bypasses PURE so official
    // built-in tabs keep working in safe mode, and defaults to no agent scope.
    mountBuiltin(slot, spec, opts) {
      if (spec == null) return;
      _warnUnknownSlot(slot, "ui.mountBuiltin");
      _register(slot, spec, opts, "host", { builtin: true });
    },

    // Register a full-page workspace under this extension. When opened it
    // takes over the main content area (host hides its own panels first) and
    // gets its own URL hash `#ext/<id>` so back/forward + reload work.
    //
    //   Clacky.ext.ui.registerWorkspace("my-console", {
    //     title: "My Console",
    //     render(container) { container.textContent = "hello"; },
    //   });
    //
    // A workspace is opened with `Clacky.ext.ui.openWorkspace(id)` — typically
    // wired to a `sidebar.nav` menu item mounted from the same extension.
    // render(container, ctx) is called every time the workspace is shown; the
    // container is cleared beforehand so the render function can be dumb.
    registerWorkspace(id, def) {
      if (PURE || !id || !def || typeof def.render !== "function") return;
      _workspaces[id] = {
        id,
        title: def.title || id,
        render: _guard(def.render, `ui.registerWorkspace(${id})`, _currentExtId),
        extId: _currentExtId,
      };
    },

    // Open a registered workspace. Emits a `clacky:ext:navigate` event that
    // the host router listens for; ext.js has no compile-time dependency on
    // the router. No-op if the id was never registered.
    openWorkspace(id) {
      if (PURE || !_workspaces[id]) return;
      document.dispatchEvent(new CustomEvent("clacky:ext:navigate", {
        detail: { view: "ext-workspace", params: { id } },
      }));
    },
  };

  // Return the per-session runtime for a mount, allocating it via `create` on
  // first use. Global mounts (or per-session slots without `create`) return
  // null — the render function is expected to work stateless.
  function _getRuntime(slot, entry, ctx) {
    if (!entry.create) return null;
    if (!PER_SESSION_SLOTS[slot]) return null;
    const sessionId = ctx && ctx.sessionId;
    if (!sessionId) return null;

    let bySession = _sessionRuntimes.get(sessionId);
    if (!bySession) {
      bySession = new Map();
      _sessionRuntimes.set(sessionId, bySession);
    }
    const key = _mountKey(slot, entry);
    let runtime = bySession.get(key);
    if (!runtime) {
      runtime = entry.create(ctx);
      if (runtime === undefined) return null;  // create threw (guarded)
      bySession.set(key, runtime || {});
    }
    return runtime;
  }

  // Run any view-level teardown collected on the previous render pass for the
  // current session, so old event listeners / RAF loops don't leak when a tab
  // is re-rendered or the session switches away.
  function _runViewTeardowns(sessionId) {
    if (!sessionId) return;
    const map = _viewTeardowns.get(sessionId);
    if (!map) return;
    map.forEach((fn) => { if (typeof fn === "function") { try { fn(); } catch (_e) {} } });
    map.clear();
  }

  function _rememberViewTeardown(sessionId, key, teardown) {
    if (!sessionId || typeof teardown !== "function") return;
    let map = _viewTeardowns.get(sessionId);
    if (!map) { map = new Map(); _viewTeardowns.set(sessionId, map); }
    map.set(key, teardown);
  }

  // Invoke a renderer's render function. Handles the (container, ctx, runtime)
  // signature used everywhere; if the render returns a function it is stored
  // as the view teardown, run before the next render or on session exit.
  function _invokeRender(slot, entry, container, ctx) {
    const runtime = _getRuntime(slot, entry, ctx);
    let node, teardown, crashed = false;
    try {
      const out = entry.render(container, ctx, runtime);
      if (out === undefined) {
        crashed = false;  // container mutated in-place is fine
      } else if (typeof out === "function") {
        teardown = out;
      } else {
        node = out;
      }
    } catch (_e) {
      crashed = true;
    }
    if (crashed) return { crashed: true };
    if (ctx && ctx.sessionId && teardown) {
      _rememberViewTeardown(ctx.sessionId, _mountKey(slot, entry), teardown);
    }
    return { node };
  }


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
      const wrap = document.createElement("div");
      if (entry.extId) wrap.setAttribute("data-ext-id", entry.extId);
      // Nav mounts that open a workspace declare it via opts.workspace; the
      // host stamps it so the Router alone owns the active highlight.
      if (entry.workspace) wrap.setAttribute("data-ext-workspace", entry.workspace);
      const { node, crashed } = _invokeRender(slot, entry, wrap, renderCtx);
      if (crashed) {
        wrap.setAttribute("data-ext-status", "crashed");
        wrap.className = "ext-slot-crashed";
        wrap.textContent = "Extension failed to render.";
        container.appendChild(wrap);
        return;
      }
      if (node != null) {
        if (typeof node === "string") wrap.innerHTML = node;
        else wrap.appendChild(node);
      }
      // If render mutated `wrap` in-place (returned nothing) or produced a
      // node, either way we only append when there's something to show.
      if (wrap.childNodes.length > 0 || (node != null && typeof node === "string")) {
        container.appendChild(wrap);
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
        const { node, crashed } = _invokeRender(slot, entry, body, localCtx);
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
  // Runs the previous session's view-level teardowns first (event listeners /
  // RAF loops attached to now-dead DOM), but leaves per-session runtimes
  // alive — the meeting recorder for session A keeps running while you're
  // looking at B, and its captions are still there when you switch back.
  function setContext(next) {
    const prevSessionId = context.sessionId;
    Object.assign(context, next || {});
    if (prevSessionId && prevSessionId !== context.sessionId) {
      _runViewTeardowns(prevSessionId);
    }
    refreshSlots();
  }

  // Called by the host when a session leaves the sidebar for good (deleted,
  // archived, or the page is unloading). Runs every runtime's `dispose()` for
  // that session so timers, media recorders, and network handles are released.
  function notifySessionRemoved(sessionId) {
    if (!sessionId) return;
    _runViewTeardowns(sessionId);
    _viewTeardowns.delete(sessionId);
    const bySession = _sessionRuntimes.get(sessionId);
    if (!bySession) return;
    bySession.forEach((runtime) => {
      if (runtime && typeof runtime.dispose === "function") {
        try { runtime.dispose(); } catch (err) {
          console.error("[Clacky.ext] runtime.dispose failed:", err);
        }
      }
    });
    _sessionRuntimes.delete(sessionId);
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
    notifySessionRemoved,
    refreshSlots,
    registerPanelAgents,
    api,
    ui,
    subscribe,
    emit,
    renderSlot,
    slots,
    // Host-only: look up a registered workspace by id. Returns
    // { id, title, render, extId } or undefined. Used by the Router when
    // handling the `ext-workspace` view — extensions never call this.
    _getWorkspace(id) { return _workspaces[id]; },
    _extBegin,  // used by the loader; not part of the public extension API
    _extEnd,    // used by the loader; not part of the public extension API
  };
})();
