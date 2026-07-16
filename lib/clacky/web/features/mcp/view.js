// ── MCP · view — rendering + DOM wiring for the MCP servers panel ──────────
//
// Owns all card/status/tools rendering and event wiring. Reads through
// McpStore.state and reacts to store events. Probe / toggle / remove go through
// store actions; confirm dialogs and error alerts (UI concerns) live here.
//
// Augments the `Mcp` facade with onPanelShow.
//
// Depends on: McpStore, I18n, global $ helper.
// ───────────────────────────────────────────────────────────────────────────

const McpView = (() => {

  function _renderLoading() {
    const list = $("mcp-list");
    const status = $("mcp-status");
    if (status) status.innerHTML = "";
    if (list) list.innerHTML = `<div class="channel-loading">${I18n.t("mcp.loading")}</div>`;
  }

  function _renderError(payload) {
    const list = $("mcp-list");
    if (list) list.innerHTML = `<div class="channel-error">${I18n.t("mcp.loadError", { msg: _esc(payload.message) })}</div>`;
  }

  function _render() {
    const list = $("mcp-list");
    const status = $("mcp-status");
    const data = McpStore.state.data;
    if (!list || !data) return;

    if (status) {
      const pathLabel = data.config_exists
        ? _esc(data.config_path)
        : `${_esc(data.config_path)} <em>${I18n.t("mcp.config.missing")}</em>`;
      status.innerHTML = `
        <div class="mcp-cta">
          <div class="mcp-cta-text">
            <h3>${I18n.t("mcp.cta.title")}</h3>
            <p>${I18n.t("mcp.cta.body")}</p>
          </div>
          <button class="btn-mcp-cta" id="btn-mcp-cta">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            ${I18n.t("mcp.cta.button")}
          </button>
        </div>
        <div class="mcp-config-line">
          <div class="mcp-config-text">
            <span class="mcp-config-label">${I18n.t("mcp.config.path")}</span>
            <code>${pathLabel}</code>
          </div>
          <button class="btn-mcp-refresh" id="btn-mcp-refresh" title="${_esc(I18n.t("mcp.btn.refresh"))}">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
              <path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
            </svg>
          </button>
        </div>
      `;
      $("btn-mcp-refresh")?.addEventListener("click", () => {
        Mcp.resetCaches();
        Mcp.load();
      });
      $("btn-mcp-cta")?.addEventListener("click", () => Mcp.askAdd());
    }

    list.innerHTML = "";

    if (!data.configured || !data.servers || data.servers.length === 0) {
      list.innerHTML = `
        <div class="mcp-empty">
          <h3>${I18n.t("mcp.empty.title")}</h3>
          <p>${I18n.t("mcp.empty.body")}</p>
          <button class="btn-mcp-cta btn-mcp-cta-large" id="btn-mcp-empty-cta">
            ${I18n.t("mcp.cta.button")}
          </button>
        </div>
      `;
      $("btn-mcp-empty-cta")?.addEventListener("click", () => Mcp.askAdd());
      return;
    }

    data.servers.forEach(server => {
      list.appendChild(_renderCard(server));
      // _renderTools uses getElementById which requires the card to already be
      // in the DOM, so we call it after appendChild (not inside _renderCard).
      if (McpStore.state.isExpanded(server.name) && !server.disabled) {
        _renderTools(server.name);
      }
    });
  }

  function _renderCard(server) {
    const card = document.createElement("div");
    card.className = "channel-card mcp-card";
    if (server.disabled) card.classList.add("mcp-card-disabled");
    card.id = `mcp-card-${_esc(server.name)}`;

    const isHttp = server.type === "http" || server.type === "streamable-http";
    const cmdLine = isHttp
      ? (server.url || "")
      : [server.command, ...(server.args || [])].filter(Boolean).join(" ");
    const cmdLabel = isHttp ? I18n.t("mcp.url") : I18n.t("mcp.command");
    const isExpanded = McpStore.state.isExpanded(server.name);
    const toggleAria = server.disabled
      ? I18n.t("mcp.toggle.off")
      : I18n.t("mcp.toggle.on");

    card.innerHTML = `
      <div class="channel-card-header">
        <div class="channel-card-identity">
          <span class="channel-logo mcp-logo" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="6" rx="1"/>
              <rect x="3" y="14" width="18" height="6" rx="1"/>
              <path d="M8 7h.01M8 17h.01"/>
            </svg>
          </span>
          <div>
            <div class="channel-card-name">${_esc(server.name)}</div>
            <div class="channel-card-desc">${_esc(server.description || "")}</div>
          </div>
        </div>
        <div class="channel-card-status">
          <label class="toggle-switch" title="${_esc(toggleAria)}">
            <input type="checkbox"
                   id="toggle-mcp-${_esc(server.name)}"
                   ${!server.disabled ? "checked" : ""}
                   aria-label="${_esc(toggleAria)}">
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <div class="channel-card-body">
        ${cmdLine ? `
          <div class="mcp-cmd-block">
            <div class="mcp-cmd-label">${cmdLabel}</div>
            <code class="mcp-cmd">${_esc(cmdLine)}</code>
          </div>
        ` : ""}
        <div class="mcp-tools-region" id="mcp-tools-${_esc(server.name)}" style="display:${isExpanded ? "block" : "none"}"></div>
      </div>

      <div class="channel-card-footer">
        <div class="channel-card-actions">
          <button class="btn-mcp-probe" id="btn-mcp-probe-${_esc(server.name)}" ${server.disabled ? "disabled" : ""}>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            ${isExpanded ? I18n.t("mcp.btn.hide") : I18n.t("mcp.btn.probe")}
          </button>
          <button class="btn-mcp-remove" id="btn-mcp-remove-${_esc(server.name)}">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/>
            </svg>
            ${I18n.t("mcp.btn.remove")}
          </button>
        </div>
      </div>
    `;

    card.querySelector(`#btn-mcp-probe-${CSS.escape(server.name)}`)
      ?.addEventListener("click", () => {
        if (server.disabled) return;
        Mcp.toggleExpand(server.name);
      });
    card.querySelector(`#btn-mcp-remove-${CSS.escape(server.name)}`)
      ?.addEventListener("click", () => _remove(server.name));
    card.querySelector(`#toggle-mcp-${CSS.escape(server.name)}`)
      ?.addEventListener("change", (ev) => _toggle(server.name, ev.target.checked));

    return card;
  }

  async function _renderTools(name) {
    const region = document.getElementById(`mcp-tools-${name}`);
    if (!region) return;

    if (McpStore.state.hasCachedTools(name)) {
      region.innerHTML = _toolsHtml(McpStore.state.cachedTools(name));
      return;
    }

    region.innerHTML = `<div class="mcp-tools-loading">${I18n.t("mcp.toolsLoading")}</div>`;

    const result = await Mcp.probe(name);
    if (!result.ok) {
      region.innerHTML = `<div class="mcp-tools-error">${I18n.t("mcp.toolsLoadError", { msg: _esc(result.error) })}</div>`;
      return;
    }
    region.innerHTML = _toolsHtml(result.tools);
  }

  function _toolsHtml(tools) {
    if (!tools || tools.length === 0) {
      return `<div class="mcp-tools-empty">${I18n.t("mcp.toolsNone")}</div>`;
    }
    const items = tools.map(t => `
      <li class="mcp-tool-item">
        <code class="mcp-tool-name">${_esc(t.name)}</code>
        ${t.description ? `<span class="mcp-tool-desc">${_esc(t.description)}</span>` : ""}
      </li>
    `).join("");
    return `
      <div class="mcp-tools-header">${I18n.t("mcp.toolsHeader")} (${tools.length})</div>
      <ul class="mcp-tool-list">${items}</ul>
    `;
  }

  async function _toggle(name, enabled) {
    await Mcp.toggle(name, enabled);
  }

  function _remove(name) {
    const msg = I18n.t("mcp.remove.confirm", { name });
    if (!window.confirm(msg)) return;
    Mcp.remove(name);
  }

  function _esc(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function _onActionError(payload) {
    const key = payload.kind === "remove" ? "mcp.remove.error" : "mcp.toggle.error";
    alert(I18n.t(key, { msg: payload.message }));
  }

  function _subscribe() {
    Mcp.on("mcp:loading", _renderLoading);
    Mcp.on("mcp:changed", _render);
    Mcp.on("mcp:error", _renderError);
    Mcp.on("mcp:actionError", _onActionError);
  }

  const viewApi = {
    onPanelShow() { return Mcp.load(); },
  };

  return { init: _subscribe, api: viewApi };
})();

Object.assign(Mcp, McpView.api);
McpView.init();
