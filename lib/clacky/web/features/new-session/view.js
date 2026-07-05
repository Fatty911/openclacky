// ── NewSession · view — landing page for #new ─────────────────────────────
//
// Renders the "start a new session" page: agent card grid, first-message
// composer, and the collapsible advanced-options section (name / model /
// working dir / init-project). Reads state from NewSessionStore and delegates
// I/O to it. On send, creates a session then hands off to Sessions.select()
// with a pending first message so the existing chat pipeline handles delivery.
//
// Depends on: NewSessionStore, Sessions, I18n, Router.
// ───────────────────────────────────────────────────────────────────────────

const NewSessionView = (() => {
  const $ = (id) => document.getElementById(id);

  let _initialized = false;
  let _modelsLoaded = false;

  function _isZh() {
    return I18n.lang && I18n.lang().startsWith("zh");
  }

  function _agentLabel(a) {
    if (_isZh() && a.title_zh) return a.title_zh;
    return a.title || a.id;
  }

  function _agentDesc(a) {
    if (_isZh() && a.description_zh) return a.description_zh;
    return a.description || "";
  }

  const LS_SEEN_AGENTS_KEY = "openclacky.newSession.seenAgents";

  function _seenAgents() {
    try {
      const raw = localStorage.getItem(LS_SEEN_AGENTS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function _markAgentSeen(id) {
    if (!id) return;
    const seen = _seenAgents();
    if (seen.includes(id)) return;
    seen.push(id);
    try { localStorage.setItem(LS_SEEN_AGENTS_KEY, JSON.stringify(seen)); } catch (e) { /* ignore */ }
  }

  // Builtin agents (general/coding/ext-studio) ship with the app and are not
  // "extensions" from the user's point of view — no EXT badge, never NEW.
  function _isBuiltin(a) {
    return a.layer === "builtin";
  }

  function _isNewAgent(a) {
    if (_isBuiltin(a) || a.source === "user") return false;
    return !_seenAgents().includes(a.id);
  }

  function _renderAgents() {
    const container = $("new-session-agents");
    if (!container) return;
    const agents = NewSessionStore.state.agents;
    const selected = NewSessionStore.state.selectedAgentId;

    container.innerHTML = "";
    agents.forEach((a) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "agent-card" + (a.id === selected ? " agent-card--selected" : "");
      card.dataset.agentId = a.id;

      const title = document.createElement("div");
      title.className = "agent-card-title";
      title.textContent = _agentLabel(a);
      if (_isNewAgent(a)) {
        const isNew = document.createElement("span");
        isNew.className = "agent-card-new";
        isNew.textContent = "NEW";
        title.appendChild(isNew);
      }
      card.appendChild(title);

      const descText = _agentDesc(a);
      if (descText) {
        const desc = document.createElement("div");
        desc.className = "agent-card-desc";
        desc.textContent = descText;
        card.appendChild(desc);
      }

      const author = (a.author || "").trim();
      if (author) {
        const by = document.createElement("div");
        by.className = "agent-card-author";
        by.textContent = _isZh() ? `作者 ${author}` : `by ${author}`;
        card.appendChild(by);
      }

      if (!_isBuiltin(a) && a.source === "extension") {
        const badge = document.createElement("span");
        badge.className = "agent-card-badge";
        badge.textContent = "EXT";
        card.appendChild(badge);
      } else if (a.source === "user") {
        const badge = document.createElement("span");
        badge.className = "agent-card-badge agent-card-badge--custom";
        badge.textContent = "custom";
        card.appendChild(badge);
      }

      card.addEventListener("click", () => {
        _markAgentSeen(a.id);
        NewSessionStore.selectAgent(a.id);
        _renderAgents();
      });
      container.appendChild(card);
    });

    _updatePlaceholder();
  }

  function _updatePlaceholder() {
    const input = $("new-session-input");
    if (!input) return;
    const agent = NewSessionStore.currentAgent();
    const label = agent ? _agentLabel(agent) : "";
    const tpl = I18n.t("sessions.new.placeholder");
    input.placeholder = label
      ? tpl.replace("{{agent}}", label)
      : tpl.replace("{{agent}}", "");
  }

  async function _populateModels() {
    if (_modelsLoaded) return;
    const select = $("new-session-model");
    if (!select) return;
    const models = await NewSessionStore.loadModels();

    select.innerHTML = "";
    if (models.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No models configured";
      select.appendChild(opt);
      _modelsLoaded = true;
      return;
    }

    models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id || "";
      const typeBadge = m.type === "default" ? "[default] " : "";
      opt.textContent = `${typeBadge}${m.model} (${m.api_key_masked})`;
      if (m.type === "default") {
        opt.selected = true;
        NewSessionStore.updateAdvanced({ modelId: opt.value });
      }
      select.appendChild(opt);
    });
    _modelsLoaded = true;
  }

  async function _prefillDefaultDir() {
    const dirInput = $("new-session-directory");
    if (!dirInput || dirInput.value) return;
    const home = await NewSessionStore.loadDefaultDirectory();
    if (home && !dirInput.value) {
      dirInput.value = home;
      NewSessionStore.updateAdvanced({ workingDir: home });
    }
  }

  function _updateInitProjectVisibility() {
    const field = $("new-session-init-project-field");
    if (!field) return;
    const agent = NewSessionStore.currentAgent();
    field.style.display = agent && agent.id === "coding" ? "block" : "none";
  }

  function _updateSendButton() {
    const btn = $("new-session-send");
    const input = $("new-session-input");
    if (!btn || !input) return;
    const hasText = input.value.trim().length > 0;
    btn.disabled = !hasText || NewSessionStore.state.creating;
  }

  async function _submit() {
    const input = $("new-session-input");
    if (!input) return;
    const content = input.value.trim();
    if (!content) return;

    const initCheckbox = $("new-session-init-project");
    const initProject = initCheckbox && initCheckbox.checked;

    const btn = $("new-session-send");
    if (btn) btn.disabled = true;

    const session = await NewSessionStore.createSession({
      existingSessions: (Sessions && Sessions.all) || [],
    });
    if (!session) {
      _updateSendButton();
      return;
    }

    Sessions.add(session);
    Sessions.setPendingMessage(session.id, content);
    input.value = "";
    NewSessionStore.reset();

    // Hand off to the normal chat pipeline: this switches the panel, wires
    // up WS subscription, and the pending message is sent once subscribed
    // (see ws-dispatcher.js "subscribed" branch).
    Sessions.select(session.id);
  }

  function _bindOnce() {
    if (_initialized) return;
    _initialized = true;

    NewSessionStore.on("newSession:agents-loaded", _renderAgents);
    NewSessionStore.on("newSession:selection-changed", () => {
      _renderAgents();
      _updateInitProjectVisibility();
    });
    NewSessionStore.on("newSession:creating", _updateSendButton);

    const input = $("new-session-input");
    if (input) {
      input.addEventListener("input", _updateSendButton);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          _submit();
        }
      });
    }

    const sendBtn = $("new-session-send");
    if (sendBtn) sendBtn.addEventListener("click", _submit);

    const toggle = $("new-session-toggle-advanced");
    const advanced = $("new-session-advanced");
    if (toggle && advanced) {
      toggle.addEventListener("click", async () => {
        const open = advanced.hidden;
        advanced.hidden = !open;
        toggle.classList.toggle("is-open", open);
        if (open) {
          await _populateModels();
          await _prefillDefaultDir();
        }
        NewSessionStore.toggleAdvanced(open);
      });
    }

    const nameInput = $("new-session-name");
    if (nameInput) {
      nameInput.addEventListener("input", (e) =>
        NewSessionStore.updateAdvanced({ name: e.target.value })
      );
    }

    const modelSelect = $("new-session-model");
    if (modelSelect) {
      modelSelect.addEventListener("change", (e) =>
        NewSessionStore.updateAdvanced({ modelId: e.target.value })
      );
    }

    const dirInput = $("new-session-directory");
    if (dirInput) {
      dirInput.addEventListener("input", (e) =>
        NewSessionStore.updateAdvanced({ workingDir: e.target.value })
      );
    }

    const browseBtn = $("new-session-browse-btn");
    if (browseBtn && dirInput) {
      browseBtn.addEventListener("click", async () => {
        const start = dirInput.value.trim();
        const picked = await window.openDirectoryPicker(start, null);
        if (picked) {
          dirInput.value = picked;
          NewSessionStore.updateAdvanced({ workingDir: picked });
        }
      });
    }

    const initCheckbox = $("new-session-init-project");
    if (initCheckbox) {
      initCheckbox.addEventListener("change", (e) =>
        NewSessionStore.updateAdvanced({ initProject: e.target.checked })
      );
    }
  }

  async function onPanelShow() {
    _bindOnce();
    if (NewSessionStore.state.agents.length === 0) {
      await NewSessionStore.loadAgents();
    } else {
      _renderAgents();
    }
    _updateInitProjectVisibility();
    _updateSendButton();
    const input = $("new-session-input");
    if (input) input.focus();
  }

  return { onPanelShow };
})();

window.NewSessionView = NewSessionView;
