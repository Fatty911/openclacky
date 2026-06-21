// ── Creator · store — cloud/local skill data + publish network ─────────────
//
// Owns the creator skill lists (cloud / local), loading flag, and the network
// calls (load catalog, publish a skill). It never renders.
//
// Emits store events the view reacts to; mirrors them to the extension bus via
// Clacky.ext.emit.
//
// `Creator` stays the single public facade.
//
// Depends on: Clacky.ext.
// ───────────────────────────────────────────────────────────────────────────

const CreatorStore = (() => {
  let _cloudSkills = [];
  let _localSkills = [];
  let _loading     = false;

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
    get cloudSkills() { return _cloudSkills; },
    get localSkills() { return _localSkills; },
    get loading()     { return _loading; },
  };

  const Creator = {
    on: _on,
    state,

    async load() {
      if (_loading) return;
      _loading = true;
      _emit("creator:loading");
      try {
        const res  = await fetch("/api/creator/skills");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Load failed");

        _cloudSkills = data.cloud_skills || [];
        _localSkills = data.local_skills || [];
        _emit("creator:changed", { platformFetchError: data.platform_fetch_error || null });
      } catch (e) {
        console.error("[Creator] load failed", e);
        _emit("creator:error", { message: e.message });
      } finally {
        _loading = false;
      }
    },

    /** Publish (or update) a skill. Returns { ok, already_exists, error }. */
    async publish(skillName, { force = false } = {}) {
      const url  = `/api/my-skills/${encodeURIComponent(skillName)}/publish${force ? "?force=true" : ""}`;
      const res  = await fetch(url, { method: "POST" });
      const data = await res.json();
      return {
        ok:             res.ok && !!data.ok,
        already_exists: !!data.already_exists,
        error:          data.error || null,
      };
    },
  };

  return Creator;
})();

const Creator = CreatorStore;
