// ── Tasks · view — rendering, DOM event wiring ─────────────────────────────
//
// Owns everything that touches the DOM: the task table, sidebar label, panel
// wiring. Reads data through TasksStore.state and reacts to store events via
// Tasks.on(...). Calls store actions; never fetches data itself.
//
// Augments the `Tasks` facade with the UI methods other modules invoke
// (onPanelShow / renderSection / renderTable).
//
// Depends on: TasksStore, I18n/Router, global $ / escapeHtml helpers.
// ───────────────────────────────────────────────────────────────────────────

const TasksView = (() => {

  function _humanCron(cron) {
    if (!cron) return cron;
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return cron;
    let [min, hour, dom, month, dow] = parts;

    // normalize */1 → *
    if (min === "*/1")   min   = "*";
    if (hour === "*/1")  hour  = "*";
    if (dom === "*/1")   dom   = "*";
    if (month === "*/1") month = "*";
    if (dow === "*/1")   dow   = "*";

    const isAny = v => v === "*";
    const isInt = v => /^\d+$/.test(v);
    const pad   = n => String(n).padStart(2, "0");

    const lang = (typeof I18n !== "undefined" && I18n.lang()) || "zh";
    const isZh = lang === "zh";

    const DOW_ZH = ["周日","周一","周二","周三","周四","周五","周六"];
    const DOW_EN = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const MON_ZH = ["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"];
    const MON_EN = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

    // dow → label, e.g. "1-5"→"工作日", "1,3,5"→"周一、周三、周五", "1"→"每周一"
    function dowLabel(d) {
      if (isAny(d)) return null;
      if (d === "1-5") return isZh ? "工作日" : "Weekdays";
      if (d === "0,6" || d === "6,0") return isZh ? "周末" : "Weekends";
      if (isInt(d)) {
        const name = (isZh ? DOW_ZH : DOW_EN)[parseInt(d, 10)] || d;
        return isZh ? `每${name}` : name;
      }
      if (/^[\d,]+$/.test(d)) {
        const names = d.split(",").map(n => (isZh ? DOW_ZH : DOW_EN)[parseInt(n, 10)] || n);
        return isZh ? names.join("、") : names.join("/");
      }
      return d;
    }

    // build HH:MM string; supports single hour or comma-list like "10,14"
    function timeStr() {
      if (!isInt(min)) return null;
      if (isInt(hour)) return `${pad(hour)}:${pad(min)}`;
      if (/^[\d,]+$/.test(hour))
        return hour.split(",").map(h => `${pad(h)}:${pad(min)}`).join(isZh ? "、" : "/");
      return null;
    }

    // ── every-N-minutes ───────────────────────────────────────────────────
    if (min.startsWith("*/") && isAny(hour) && isAny(dom) && isAny(month) && isAny(dow)) {
      const n = min.slice(2);
      return isZh ? `每 ${n} 分钟` : `Every ${n} min`;
    }
    // ── every-N-hours ─────────────────────────────────────────────────────
    if (isAny(dom) && isAny(month) && isAny(dow)) {
      if (isAny(min) && hour.startsWith("*/")) {
        return isZh ? `每 ${hour.slice(2)} 小时` : `Every ${hour.slice(2)} hr`;
      }
      if (isInt(min) && hour.startsWith("*/")) {
        return isZh ? `每 ${hour.slice(2)} 小时` : `Every ${hour.slice(2)} hr`;
      }
    }
    // ── every-N-hours on specific days  e.g. 0 */3 * * 1-5 ────────────
    if (isAny(dom) && isAny(month) && !isAny(dow) && hour.startsWith("*/")) {
      const dl = dowLabel(dow);
      const ev = isZh ? `每 ${hour.slice(2)} 小时` : `Every ${hour.slice(2)} hr`;
      if (dl) return `${dl} ${ev}`;
    }
    // ── every minute ──────────────────────────────────────────────────────
    if (isAny(min) && isAny(hour) && isAny(dom) && isAny(month) && isAny(dow)) {
      return isZh ? "每分钟" : "Every minute";
    }
    // ── hourly at :MM ─────────────────────────────────────────────────────
    if (isInt(min) && isAny(hour) && isAny(dom) && isAny(month) && isAny(dow)) {
      return isZh ? `每小时 :${pad(min)}` : `Hourly at :${pad(min)}`;
    }
    // ── hourly at :MM on specific days  e.g. 30 * * * 1-5 ─────────────
    if (isInt(min) && isAny(hour) && isAny(dom) && isAny(month) && !isAny(dow)) {
      const dl = dowLabel(dow);
      const tm = isZh ? `每小时 :${pad(min)}` : `Hourly at :${pad(min)}`;
      if (dl) return `${dl} ${tm}`;
    }

    // ── every-N-min within hour range on certain days  e.g. */1 9-14 * * 1-5
    if (min.startsWith("*/") && /^\d+-\d+$/.test(hour) && isAny(dom) && isAny(month)) {
      const n   = min.slice(2);
      const dl  = dowLabel(dow);
      const hr  = isZh ? `${hour}时` : `${hour}h`;
      const ev  = isZh ? `每 ${n} 分钟` : `Every ${n} min`;
      return dl ? `${dl} ${hr} ${ev}` : `${hr} ${ev}`;
    }
    // ── every minute within hour range  e.g. * 9-14 * * 1-5
    if (isAny(min) && /^\d+-\d+$/.test(hour) && isAny(dom) && isAny(month)) {
      const dl = dowLabel(dow);
      const hr = isZh ? `${hour}时` : `${hour}h`;
      const ev = isZh ? "每分钟" : "Every minute";
      return dl ? `${dl} ${hr} ${ev}` : `${hr} ${ev}`;
    }

    const ts  = timeStr();
    const dl  = dowLabel(dow);

    // ── fixed time, variable days ─────────────────────────────────────────
    if (ts && isAny(dom) && isAny(month)) {
      if (dl) return `${dl} ${ts}`;
      return isZh ? `每天 ${ts}` : `Daily ${ts}`;
    }
    // ── fixed time, fixed day-of-month ────────────────────────────────────
    if (ts && isInt(dom) && isAny(month) && isAny(dow)) {
      return isZh ? `每月 ${dom} 日 ${ts}` : `Monthly day ${dom} ${ts}`;
    }
    // ── fixed time, fixed date ────────────────────────────────────────────
    if (ts && isInt(dom) && isInt(month) && isAny(dow)) {
      const m = (isZh ? MON_ZH : MON_EN)[parseInt(month, 10) - 1] || month;
      return isZh ? `${m}${dom}日 ${ts}` : `${m} ${dom} ${ts}`;
    }

    return cron;
  }

  function _renderTaskRow(t) {
    const row = document.createElement("div");
    row.className = "task-card";
    row.dataset.name = t.name;

    const isPaused = t.scheduled && t.enabled === false;
    row.classList.toggle("task-card-paused", isPaused);

    const schedLabel = t.scheduled
      ? `<span class="task-card-cron" title="${escapeHtml(t.cron)}">${escapeHtml(_humanCron(t.cron))}</span>`
      : `<span class="task-card-cron task-card-cron-manual">${I18n.t("tasks.manual")}</span>`;

    const pausedBadge = isPaused
      ? `<span class="task-card-badge task-card-badge-paused">${I18n.t("tasks.paused")}</span>`
      : "";

    const content = t.content || "";
    const isTruncated = content.trim().length > 0;
    const previewText = escapeHtml(content.replace(/\s+/g, " ").trim()) || escapeHtml(I18n.t("tasks.empty"));

    const toggleBtnHtml = t.scheduled ? (isPaused
      ? `<button class="task-action-btn task-btn-toggle task-btn-resume">
           <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
             <polygon points="6 3 20 12 6 21 6 3"/>
           </svg>
           <span>${I18n.t("tasks.btn.resume")}</span>
         </button>`
      : `<button class="task-action-btn task-btn-toggle task-btn-pause">
           <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
             <rect x="6" y="4" width="4" height="16" rx="1"/>
             <rect x="14" y="4" width="4" height="16" rx="1"/>
           </svg>
           <span>${I18n.t("tasks.btn.pause")}</span>
         </button>`
    ) : "";

    row.innerHTML = `
      <div class="task-card-main">
        <div class="task-card-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
        </div>
        <div class="task-card-info">
          <div class="task-card-title-row">
            <span class="task-card-name">${escapeHtml(t.name)}</span>
            ${pausedBadge}
            ${schedLabel}
          </div>
          <div class="task-card-preview${isTruncated ? " task-card-preview-expandable" : ""}">${previewText}</div>
        </div>
        <div class="task-card-actions">
          <button class="task-run-btn task-btn-run" title="${I18n.t("tasks.btn.run")}">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="6 3 20 12 6 21 6 3"/>
            </svg>
            <span>${I18n.t("tasks.btn.run")}</span>
          </button>
          ${toggleBtnHtml}
          <button class="task-action-btn task-btn-edit">
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
              <path d="m15 5 4 4"/>
            </svg>
            <span>${I18n.t("tasks.btn.edit")}</span>
          </button>
          <button class="task-action-btn task-btn-del">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18"/><path d="M19 6l-1 14H6L5 6"/><path d="M8 6V4h8v2"/>
            </svg>
            <span>${I18n.t("tasks.btn.delete")}</span>
          </button>
        </div>
      </div>
      ${isTruncated ? `<div class="task-card-detail" hidden><pre class="task-card-detail-content">${escapeHtml(content)}</pre></div>` : ""}`;

    row.querySelector(".task-btn-run").addEventListener("click", e => {
      e.stopPropagation();
      Tasks.run(t.name);
    });

    if (isTruncated) {
      const previewEl = row.querySelector(".task-card-preview");
      const detailEl  = row.querySelector(".task-card-detail");
      previewEl.addEventListener("click", e => {
        e.stopPropagation();
        const expanded = !detailEl.hidden;
        detailEl.hidden = expanded;
        row.classList.toggle("task-card-expanded", !expanded);
      });
    }
    const toggleBtn = row.querySelector(".task-btn-toggle");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", e => {
        e.stopPropagation();
        Tasks.toggleEnabled(t.name, isPaused);
      });
    }
    row.querySelector(".task-btn-edit").addEventListener("click", e => {
      e.stopPropagation();
      Tasks.editInSession(t.name);
    });
    row.querySelector(".task-btn-del").addEventListener("click", e => {
      e.stopPropagation();
      Tasks.delete(t.name);
    });

    return row;
  }

  function _renderTable() {
    const table = $("task-list-table");
    if (!table) return;
    table.innerHTML = "";

    const tasks = TasksStore.state.tasks;
    if (tasks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "task-table-empty";
      empty.innerHTML = `
        <p>${I18n.t("tasks.noScheduled")}</p>
        <button class="task-create-btn" id="btn-create-task-empty">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon-sm">
            <path d="M5 12h14"/>
            <path d="M12 5v14"/>
          </svg> ${I18n.t("tasks.btn.createTask")}
        </button>`;
      table.appendChild(empty);
      const btn = table.querySelector("#btn-create-task-empty");
      if (btn) btn.addEventListener("click", () => Tasks.createInSession());
      return;
    }

    tasks.forEach(t => table.appendChild(_renderTaskRow(t)));
  }

  function _renderSection() {
    const labelEl = $("tasks-sidebar-label");
    if (!labelEl) return;
    labelEl.textContent = I18n.t("sidebar.tasks");
  }

  function _subscribe() {
    Tasks.on("tasks:changed", () => {
      _renderSection();
      if (Router.current === "tasks") _renderTable();
    });
  }

  const viewApi = {
    renderSection: _renderSection,
    renderTable: _renderTable,

    onPanelShow() {
      Tasks.load();
      const btn = $("btn-create-task");
      if (btn) btn.onclick = () => Tasks.createInSession();
    },
  };

  return { init: _subscribe, api: viewApi };
})();

Object.assign(Tasks, TasksView.api);
TasksView.init();
