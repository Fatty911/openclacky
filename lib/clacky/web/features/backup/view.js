// ── Backup · view — settings rendering, toggles, download UI ──────────────
//
// Renders the backup settings panel, wires the toggles + download button, and
// drives the file download from a blob. Reads through BackupStore.state; all
// I/O goes through store actions. Re-renders on store change events.
//
// Augments the `Backup` facade with load (re-exposing the store action so the
// existing Settings caller keeps working).
//
// Depends on: BackupStore, I18n.
// ───────────────────────────────────────────────────────────────────────────

const BackupView = (() => {
  const $ = (id) => document.getElementById(id);

  function _fmtDate(iso) {
    if (!iso) return "";
    try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
  }

  function _render() {
    const cfg = Backup.state.config;
    if (!Backup.state.status) return;

    const incl = $("backup-include-sessions");
    if (incl) {
      incl.checked  = cfg.include_sessions !== false;
      incl.disabled = !cfg.enabled;
    }

    const autoToggle = $("backup-auto-toggle");
    if (autoToggle) autoToggle.checked = !!cfg.enabled;

    _renderLastRun(cfg);
  }

  function _renderLastRun(cfg) {
    const el = $("backup-status");
    if (!el) return;
    if (!cfg.last_run_at) { el.textContent = ""; el.className = "model-test-result"; return; }
    if (cfg.last_status === "error") {
      el.textContent = I18n.t("settings.backup.lastError", { msg: cfg.last_error || "" });
      el.className = "model-test-result error";
    } else {
      el.textContent = I18n.t("settings.backup.lastOk", { time: _fmtDate(cfg.last_run_at) });
      el.className = "model-test-result success";
    }
  }

  async function _downloadNow() {
    const btn = $("btn-backup-now");
    const el = $("backup-status");
    if (btn) btn.disabled = true;
    if (el) { el.textContent = I18n.t("settings.backup.running"); el.className = "model-test-result"; }

    const res = await Backup.fetchArchive();
    if (res.ok) {
      const url = URL.createObjectURL(res.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      if (el) { el.textContent = I18n.t("settings.backup.downloaded"); el.className = "model-test-result success"; }
    } else if (el) {
      el.textContent = I18n.t("settings.backup.lastError", { msg: res.error });
      el.className = "model-test-result error";
    }
    if (btn) btn.disabled = false;
  }

  function _bind() {
    const btn = $("btn-backup-now");
    if (btn) btn.addEventListener("click", _downloadNow);

    const autoToggle = $("backup-auto-toggle");
    if (autoToggle) autoToggle.addEventListener("change", () => Backup.saveConfig({ enabled: autoToggle.checked }));

    const incl = $("backup-include-sessions");
    if (incl) incl.addEventListener("change", () => Backup.saveConfig({ include_sessions: incl.checked }));
  }

  function _subscribe() {
    Backup.on("backup:changed", _render);
    document.addEventListener("DOMContentLoaded", _bind);
  }

  return { init: _subscribe };
})();

BackupView.init();
window.Backup = Backup;
