// ── Extensions · view — rendering, DOM wiring for the extension marketplace ─
//
// The view owns everything DOM: the search bar, sort control, extension cards,
// loading/empty states. It reads data only through ExtensionsStore.state and
// reacts to store events via Extensions.on(...). It never fetches directly — it
// calls store actions.
//
// The panel is read-only: extensions are delivered inside license-gated brand
// packages, so there is no install button here, only a "how to get" hint.
//
// Depends on: ExtensionsStore (store.js), I18n/Router, global $ / escapeHtml.
// ───────────────────────────────────────────────────────────────────────────

const ExtensionsView = (() => {
  let _domWired    = false;
  let _searchTimer = null;

  function _renderLoading() {
    const container = $("extensions-list");
    if (!container) return;
    container.innerHTML = Array.from({ length: 4 }).map(() => `
      <div class="extension-card">
        <div class="extension-card-main">
          <span class="skel" style="height:2rem;width:2rem;border-radius:8px;"></span>
          <div class="extension-info">
            <span class="skel skel-title"></span>
            <span class="skel skel-subtitle"></span>
          </div>
        </div>
      </div>`).join("");
  }

  function _renderEmpty() {
    const container = $("extensions-list");
    if (!container) return;
    const key = ExtensionsStore.state.query ? "extensions.noResults" : "extensions.empty";
    container.innerHTML = `<div class="extensions-empty">${escapeHtml(I18n.t(key))}</div>`;
  }

  function _renderList() {
    const container = $("extensions-list");
    if (!container) return;

    if (ExtensionsStore.state.loading) { _renderLoading(); return; }

    const list = ExtensionsStore.state.extensions;
    if (!list || list.length === 0) { _renderEmpty(); return; }

    container.innerHTML = "";
    list.forEach(ext => container.appendChild(_renderCard(ext)));

    _applyWarning(ExtensionsStore.state.error);
  }

  function _applyWarning(warning) {
    const banner = $("extensions-warning");
    if (!banner) return;
    if (warning) {
      banner.textContent   = warning;
      banner.style.display = "";
    } else {
      banner.style.display = "none";
    }
  }

  function _renderCard(ext) {
    const currentLang = I18n.lang();
    const name = (currentLang === "zh" && ext.name_zh) ? ext.name_zh : ext.name;
    const description = (currentLang === "zh" && ext.description_zh)
      ? ext.description_zh
      : ext.description || "";
    const emoji = ext.emoji || "🧩";

    const versionHtml = ext.version
      ? `<span class="extension-version">v${escapeHtml(String(ext.version))}</span>` : "";
    const unitsHtml = ext.units
      ? `<span class="extension-units">${escapeHtml(String(ext.units))}</span>` : "";
    const homepageHtml = ext.homepage
      ? `<a class="extension-homepage" href="${escapeHtml(ext.homepage)}" target="_blank" rel="noopener noreferrer">${I18n.t("extensions.homepage")}</a>`
      : "";

    const card = document.createElement("div");
    card.className = "extension-card";
    card.innerHTML = `
      <div class="extension-card-main">
        <div class="extension-emoji">${escapeHtml(emoji)}</div>
        <div class="extension-info">
          <div class="extension-title">
            <span class="extension-name">${escapeHtml(name)}</span>
            ${versionHtml}
            ${unitsHtml}
          </div>
          <div class="extension-desc">${escapeHtml(description)}</div>
          <div class="extension-meta">
            <span class="extension-delivery">${I18n.t("extensions.delivery")}</span>
            ${homepageHtml}
          </div>
        </div>
      </div>`;
    return card;
  }

  function _wireDom() {
    if (_domWired) return;

    const input = $("extensions-search-input");
    if (input) {
      input.placeholder = I18n.t("extensions.searchPlaceholder");
      input.addEventListener("input", () => {
        clearTimeout(_searchTimer);
        _searchTimer = setTimeout(() => Extensions.setQuery(input.value), 300);
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); clearTimeout(_searchTimer); Extensions.setQuery(input.value); }
      });
    }

    const sortSelect = $("extensions-sort");
    if (sortSelect) {
      sortSelect.value = ExtensionsStore.state.sort;
      sortSelect.addEventListener("change", () => Extensions.setSort(sortSelect.value));
    }

    document.addEventListener("langchange", () => {
      if (input) input.placeholder = I18n.t("extensions.searchPlaceholder");
      _renderList();
    });

    _domWired = true;
  }

  function _subscribe() {
    Extensions.on("extensions:loading", _renderLoading);
    Extensions.on("extensions:changed", _renderList);
    Extensions.on("extensions:error",   _renderList);
  }

  const viewApi = {
    onPanelShow() {
      _wireDom();
      Extensions.load();
    },
  };

  return { init: _subscribe, api: viewApi };
})();

Object.assign(Extensions, ExtensionsView.api);
ExtensionsView.init();
