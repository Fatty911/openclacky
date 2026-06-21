// ── Version · store — version data, upgrade lifecycle, network ────────────
//
// Owns the version data and the upgrade/restart lifecycle state machine plus
// every network call (check, upgrade, restart, reconnect polling) and the WS
// event ingestion. It never renders — it emits "version:changed" carrying a
// full state snapshot the view re-renders from.
//
// `Version` stays the single public facade (checkVersion).
//
// Depends on: WS, Clacky.ext.
// ───────────────────────────────────────────────────────────────────────────

const VersionStore = (() => {
  let _current        = null;
  let _latest         = null;
  let _needsUpdate    = false;
  let _upgrading      = false;
  let _needsRestart   = false;
  let _reconnecting   = false;
  let _upgradeDone    = false;
  let _restartFailed  = false;
  let _logLines       = [];
  let _cliCommand     = "openclacky";

  let _reconnectTimer = null;
  let _reconnectDeadline = 0;
  const RECONNECT_TIMEOUT_MS = 30_000;

  const _listeners = {};

  function _on(event, handler) {
    (_listeners[event] ||= []).push(handler);
    return () => {
      const list = _listeners[event];
      const i = list ? list.indexOf(handler) : -1;
      if (i >= 0) list.splice(i, 1);
    };
  }

  function snapshot() {
    return {
      current:       _current,
      latest:        _latest,
      needsUpdate:   _needsUpdate,
      upgrading:     _upgrading,
      needsRestart:  _needsRestart,
      reconnecting:  _reconnecting,
      upgradeDone:   _upgradeDone,
      restartFailed: _restartFailed,
      logLines:      _logLines.slice(),
      cliCommand:    _cliCommand,
    };
  }

  function _emit(extra) {
    const payload = Object.assign(snapshot(), extra || {});
    (_listeners["version:changed"] || []).forEach((h) => h(payload));
    if (window.Clacky && Clacky.ext) Clacky.ext.emit("version:changed", payload);
  }

  async function checkVersion() {
    try {
      const res = await fetch("/api/version");
      if (!res.ok) return;
      const data = await res.json();
      _current     = data.current;
      _latest      = data.latest;
      _needsUpdate = !!data.needs_update;
      if (data.cli_command) _cliCommand = data.cli_command;
      _emit();
    } catch (e) {
      console.warn("[Version] check failed:", e);
    }
  }

  async function startUpgrade() {
    if (_upgrading || _upgradeDone) return;
    _upgrading = true;
    _logLines  = [];
    _emit({ reason: "upgrade-start" });
    try {
      await fetch("/api/version/upgrade", { method: "POST" });
    } catch (e) {
      console.warn("[Version] upgrade request failed:", e);
      _upgrading = false;
      _emit();
    }
  }

  function startRestart() {
    _reconnecting = true;
    _emit({ reason: "restart-start" });
    try {
      fetch("/api/restart", { method: "POST" }).catch(() => {});
    } catch (_) {}
    _waitForReconnect();
  }

  function _waitForReconnect() {
    if (_reconnectTimer) clearInterval(_reconnectTimer);
    _reconnectDeadline = Date.now() + RECONNECT_TIMEOUT_MS;
    setTimeout(() => {
      _reconnectTimer = setInterval(async () => {
        if (Date.now() > _reconnectDeadline) {
          clearInterval(_reconnectTimer);
          _reconnectTimer = null;
          _reconnecting   = false;
          _restartFailed  = true;
          _emit({ reason: "restart-failed" });
          return;
        }
        try {
          const res = await fetch("/api/version", { cache: "no-store" });
          if (res.ok) {
            clearInterval(_reconnectTimer);
            _reconnectTimer = null;
            _reconnecting = false;
            _needsRestart = false;
            _upgradeDone  = true;
            _emit({ reason: "reconnected" });
          }
        } catch (_) { /* server not yet up */ }
      }, 2000);
    }, 2500);
  }

  function retryReconnect() {
    _restartFailed = false;
    _reconnecting  = true;
    _emit({ reason: "retry-reconnect" });
    _waitForReconnect();
  }

  function _handleWsEvent(event) {
    if (event.type === "upgrade_log") {
      _logLines.push(event.line || "");
      _emit({ reason: "log", line: event.line || "" });
    } else if (event.type === "upgrade_complete") {
      _upgrading = false;
      if (event.success) {
        _needsUpdate  = false;
        _needsRestart = true;
        _upgradeDone  = false;
      }
      _emit({ reason: "upgrade-complete", success: !!event.success });
    }
  }

  const Version = {
    on: _on,
    snapshot,
    checkVersion,
    startUpgrade,
    startRestart,
    retryReconnect,

    bootWs() {
      if (typeof WS !== "undefined") WS.onEvent(_handleWsEvent);
    },
  };

  return Version;
})();

const Version = VersionStore;
