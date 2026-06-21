// ── SkillAC — slash-command autocomplete + composer bindings ──────────────
// NOTE: The Skills data/render module moved to features/skills/{store,view}.js.
// Only the composer-side autocomplete lives here.

// ─────────────────────────────────────────────────────────────────────────
// SkillAC — slash-command skill autocomplete dropdown + composer bindings
//
// Handles the "/xxx" slash-command autocomplete UI above the message input,
// plus all composer keyboard/composition/input DOM bindings that depend on it
// (Enter to send, / button, IME composition guard).
//
// Moved verbatim from app.js; structural changes only:
//   - `_lastCompositionEndTime` moved into the IIFE closure (was module-level)
//   - The bare DOM bindings (btn-slash, user-input keydown/input/compositionend,
//     btn-create-skill, btn-import-skill) are wrapped in a private
//     `_initDOMBindings()` function called at the end of `init()`.
//
// Depends on: Sessions (sendMessage), Skills (createInSession, toggleImportBar),
//             I18n, global $ helper.
// ─────────────────────────────────────────────────────────────────────────
const SkillAC = (() => {
  let _initialized    = false;
  let _visible        = false;
  let _activeIndex    = -1;
  let _items          = [];  // filtered [{ name, description, encrypted, source }]
  let _currentSession = null; // track active session id for live fetch

  // Load from localStorage, default to false (hide system skills)
  let _showSystemSkills = localStorage.getItem("skill-ac-show-system") === "true";

  let _ime = null;  // IME tracker for #user-input, set up in _initDOMBindings

  /** Called whenever the active session changes — just store the id, no prefetch. */
  function _loadForSession(sessionId) {
    _currentSession = sessionId || null;
  }

  /** Fetch live skill list from server for the current session. */
  async function _fetchSkills() {
    if (!_currentSession) return [];
    try {
      const res  = await fetch(`/api/sessions/${_currentSession}/skills`);
      const data = await res.json();
      return data.skills || [];
    } catch (e) {
      console.error("[SkillAC] fetchSkills failed", e);
      return [];
    }
  }

  /** Return the /xxx prefix if the entire input is a slash command, else null. */
  function _getSlashQuery(value) {
    // Full-width slash / dunhao are already replaced in the input event handler,
    // but guard here too in case value is passed programmatically.
    let trimmed = value.replace(/^[／、]/, "/");

    // Only activate when the whole input starts with / (no leading space)
    if (!trimmed.startsWith("/")) return null;
    // Only single-word slash token — no spaces allowed after /
    if (/^\/\S*$/.test(trimmed)) return trimmed.slice(1).toLowerCase();
    return null;
  }

  /**
   * Score how well a skill matches the query string.
   * Only matches against name and name_zh — description is intentionally excluded.
   * All matches are contiguous substring matches (no fuzzy/subsequence).
   * Returns 0 if no match (should be filtered out).
   *
   * Scoring tiers:
   *   100 — name or name_zh exact match
   *    80 — name or name_zh starts-with
   *    60 — name or name_zh contains
   *     0 — no match
   */
  function _scoreMatch(skill, query) {
    if (!query) return 50; // empty query → show all with neutral score

    const q    = query.toLowerCase();
    const name = (skill.name || "").toLowerCase();
    const zh   = (skill.name_zh || "").toLowerCase();

    // Exact match
    if (name === q || zh === q) return 100;

    // Prefix match
    if (name.startsWith(q) || zh.startsWith(q)) return 80;

    // Contains match (contiguous substring)
    if (name.includes(q) || zh.includes(q)) return 60;

    return 0;
  }

  /**
   * Wrap the matching substring in <mark> for highlighting.
   * Returns an array of DOM nodes (text + mark nodes).
   */
  function _highlight(text, query) {
    if (!query) return [document.createTextNode(text)];
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return [document.createTextNode(text)];

    const nodes = [];
    if (idx > 0) nodes.push(document.createTextNode(text.slice(0, idx)));
    const mark = document.createElement("span");
    mark.className = "skill-ac-highlight";
    mark.textContent = text.slice(idx, idx + query.length);
    nodes.push(mark);
    if (idx + query.length < text.length) {
      nodes.push(document.createTextNode(text.slice(idx + query.length)));
    }
    return nodes;
  }

  async function _render(query) {
    const all = await _fetchSkills();

    // Score and filter
    let scored = all
      .map(s => ({ skill: s, score: _scoreMatch(s, query) }))
      .filter(({ score }) => score > 0);

    if (!_showSystemSkills) {
      scored = scored.filter(({ skill }) => skill.always_show || skill.source_type !== "default");
    }

    // Sort by score descending, stable secondary sort by name
    scored.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));

    _items = scored.map(({ skill }) => skill);

    const list = $("skill-autocomplete-list");
    list.innerHTML = "";

    if (_items.length === 0) {
      // Show empty state instead of hiding the dropdown
      const emptyEl = document.createElement("div");
      emptyEl.className = "skill-ac-empty";
      emptyEl.textContent = I18n.t("skills.ac.empty");
      list.appendChild(emptyEl);
      $("skill-autocomplete").style.display = "";
      _visible = true;
      _createOverlay();
      return;
    }

    _items.forEach((skill, idx) => {
      const item = document.createElement("div");
      item.className = "skill-ac-item" + (idx === _activeIndex ? " active" : "");
      item.setAttribute("role", "option");
      item.setAttribute("data-idx", idx);

      const nameEl = document.createElement("span");
      nameEl.className = "skill-ac-name";

      const currentLangForName = I18n.lang();
      const showZhFirst = currentLangForName === "zh" && skill.name_zh;

      if (showZhFirst) {
        // Chinese UI: /中文名 first (with slash), then english id (no slash) after
        const zhEl = document.createElement("span");
        zhEl.className = "skill-ac-name-zh";
        zhEl.appendChild(document.createTextNode("/"));
        _highlight(skill.name_zh, query).forEach(function(n) { zhEl.appendChild(n); });
        nameEl.appendChild(zhEl);

        const nameTextEl = document.createElement("span");
        nameTextEl.className = "skill-ac-name-id";
        _highlight(skill.name, query).forEach(function(n) { nameTextEl.appendChild(n); });
        nameEl.appendChild(nameTextEl);
      } else {
        // English UI (or no zh name): show /id only, no zh name
        const nameTextEl = document.createElement("span");
        nameTextEl.appendChild(document.createTextNode("/"));
        _highlight(skill.name, query).forEach(function(n) { nameTextEl.appendChild(n); });
        nameEl.appendChild(nameTextEl);
      }

      // meta: encrypted badge + source type label (subtle)
      const metaEl = document.createElement("span");
      metaEl.className = "skill-ac-meta";
      if (skill.encrypted) {
        const encBadge = document.createElement("span");
        encBadge.className = "skill-ac-enc";
        encBadge.textContent = "🔒";
        metaEl.appendChild(encBadge);
      }
      const sourceLabel = {
        "default":        "built-in",
        "global_clacky":  "user",
        "global_claude":  "user",
        "project_clacky": "project",
        "project_claude": "project",
        "brand":          "brand",
      }[skill.source_type];
      if (sourceLabel) {
        const srcEl = document.createElement("span");
        srcEl.className = "skill-ac-src";
        srcEl.textContent = sourceLabel;
        metaEl.appendChild(srcEl);
      }

      const descEl = document.createElement("span");
      descEl.className = "skill-ac-desc";
      // Choose description based on current language
      const description = (currentLangForName === "zh" && skill.description_zh)
                          ? skill.description_zh
                          : skill.description || "";
      descEl.textContent = description;

      item.appendChild(nameEl);
      item.appendChild(metaEl);
      item.appendChild(descEl);

      item.addEventListener("mousedown", e => {
        // mousedown fires before blur — prevent input losing focus
        e.preventDefault();
        _select(idx);
      });

      list.appendChild(item);
    });

    $("skill-autocomplete").style.display = "";
    _visible = true;
    _createOverlay();
  }

  function _hide() {
    $("skill-autocomplete").style.display = "none";
    _visible     = false;
    _activeIndex = -1;
    _items       = [];
    $("btn-slash")?.classList.remove("active");
    _removeOverlay();
  }

  function _createOverlay() {
    // Remove existing overlay if any
    _removeOverlay();

    const overlay = document.createElement("div");
    overlay.id = "skill-ac-overlay";
    overlay.style.cssText = "position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 999; background: transparent;";

    // Click overlay to close dropdown
    overlay.addEventListener("click", () => {
      _hide();
    });

    document.body.appendChild(overlay);
  }

  function _removeOverlay() {
    const overlay = document.getElementById("skill-ac-overlay");
    if (overlay) overlay.remove();
  }

  function _select(idx) {
    const skill = _items[idx];
    if (!skill) return;
    const input  = $("user-input");
    input.value  = "/" + skill.name + " ";
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
    _hide();
    input.focus();
  }

  function _moveActive(delta) {
    if (!_visible || _items.length === 0) return;
    _activeIndex = (_activeIndex + delta + _items.length) % _items.length;
    // Re-render to apply active class
    const list  = $("skill-autocomplete-list");
    list.querySelectorAll(".skill-ac-item").forEach((el, i) => {
      el.classList.toggle("active", i === _activeIndex);
      if (i === _activeIndex) el.scrollIntoView({ block: "nearest" });
    });
  }

  /** Open the dropdown showing all skills, used by the / button. */
  async function _openAll() {
    _activeIndex = 0;  // Default to first item
    await _render("");
    $("user-input").focus();
  }

  /** Toggle the dropdown (open if hidden, close if visible). */
  async function _toggle() {
    if (_visible) {
      _hide();
    } else {
      await _openAll();
    }
  }

  // ── DOM bindings: composer keyboard/composition/input + slash button + ────
  // ── skill-panel create/import buttons. Called once from init().           ──
  function _initDOMBindings() {
    // / button: set input to "/" and open skill autocomplete.
    // mousedown + preventDefault prevents the textarea from losing focus
    // (which would trigger the blur→hide timer and immediately close
    //  the dropdown we're about to open).
    $("btn-slash").addEventListener("mousedown", e => {
      e.preventDefault();  // keep focus on user-input
    });
    $("btn-slash").addEventListener("click", () => {
      const input = $("user-input");
      if (input.value === "" || input.value === "/") {
        input.value = "/";
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 200) + "px";
      }
      _toggle();  // Toggle dropdown instead of always opening
      if (_visible) {
        $("btn-slash").classList.add("active");
      }
      input.focus();
    });

    // IME composition tracker: shared by main keydown + AC _handleKey.
    _ime = IME.track($("user-input"));

    // Main composer keydown: SkillAC consumes nav keys first, then Enter → send.
    $("user-input").addEventListener("keydown", e => {
      // Let skill autocomplete consume arrow/enter/escape first
      if (_handleKey(e)) return;

      if (e.key === "Enter" && !e.shiftKey && !_ime.isComposing(e)) {
        e.preventDefault();
        Sessions.sendMessage();
      }
    });

    // Composer input: auto-grow textarea, normalize full-width slash, drive AC.
    $("user-input").addEventListener("input", () => {
      const el = $("user-input");
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";

      // Replace full-width slash ／ or Chinese dunhao 、 with ASCII / in-place
      if (/^[／、]/.test(el.value)) {
        const pos = el.selectionStart;
        el.value = el.value.replace(/^[／、]/, "/");
        el.setSelectionRange(pos, pos);
      }

      // Trigger skill autocomplete
      _update(el.value);
    });

    // Skills panel action buttons (domain belongs to Skills, but the
    // bindings live here because this is where all composer/skill-related
    // DOM wiring was historically colocated).
    $("btn-create-skill").addEventListener("click", () => Skills.createInSession());
    $("btn-import-skill").addEventListener("click", () => Skills.toggleImportBar());
  }

  // Update handler — driven from the input event above. Exposed on the
  // public API for programmatic use too.
  function _update(value) {
    const query = _getSlashQuery(value);
    if (query === null) { _hide(); return; }
    _activeIndex = 0;  // Always highlight the first match
    _render(query);  // async, fire-and-forget
  }

  // Keyboard handler for the dropdown. Returns true if the event was consumed.
  function _handleKey(e) {
    if (!_visible) return false;
    if (e.key === "ArrowDown") { e.preventDefault(); _moveActive(1);  return true; }
    if (e.key === "ArrowUp")   { e.preventDefault(); _moveActive(-1); return true; }
    if (e.key === "Escape")    { e.preventDefault(); _hide();         return true; }
    if (e.key === "Tab") {
      // Tab: select active item if one is highlighted, otherwise select first item
      e.preventDefault();
      const targetIdx = _activeIndex >= 0 ? _activeIndex : 0;
      _select(targetIdx);
      return true;
    }
    if (e.key === "Enter" && !_ime.isComposing(e)) {
      if (_activeIndex >= 0) {
        e.preventDefault();
        _select(_activeIndex);
        return true;
      }
      // No item highlighted — select first item if available
      if (_items.length > 0) {
        e.preventDefault();
        _select(0);
        return true;
      }
      // No items — let Enter fall through to sendMessage
      _hide();
      return false;
    }
    return false;
  }

  return {
    get visible()      { return _visible; },
    get activeIndex()  { return _activeIndex; },

    /** Initialize event listeners (call once on page load). */
    init() {
      if (_initialized) return;
      _initialized = true;

      const chk = $("chk-ac-show-system-skills");

      if (chk) {
        // Restore state from localStorage
        chk.checked = _showSystemSkills;

        chk.addEventListener("change", async () => {
          _showSystemSkills = chk.checked;
          // Persist to localStorage
          localStorage.setItem("skill-ac-show-system", _showSystemSkills ? "true" : "false");

          // If dropdown is visible, re-fetch and re-render
          if (_visible) {
            const input = $("user-input");
            const query = _getSlashQuery(input.value);
            if (query !== null) {
              await _render(query);
            }
          }
        });
      }

      // Wire up all composer/slash DOM bindings.
      _initDOMBindings();
    },

    /** Called on every `input` event — decide whether to show/hide/update. */
    update: _update,

    /** Open dropdown with all skills (triggered by / button). */
    openAll: _openAll,

    /** Toggle dropdown visibility (used by / button). */
    toggle: _toggle,

    /** Hide the dropdown. */
    hide: _hide,

    /** Reload session-scoped skill list when the active session changes. */
    loadForSession: _loadForSession,

    /** Handle keyboard nav inside the dropdown. Returns true if event was consumed. */
    handleKey: _handleKey,
  };
})();
