// theme.js — Theme switcher module
//
// Single storage key "clacky-theme" stores one of: light | dark | dim | warm
// All four values are first-class themes — no separate "bg-theme" dimension.
//
// Usage:
//   Theme.init()               — call once on page load
//   Theme.apply("dark"|…)      — set any theme explicitly
//   Theme.current()            — returns effective data-theme value

const Theme = (() => {
  const STORAGE_KEY = "clacky-theme";
  const ATTR_NAME   = "data-theme";

  // ── Helpers ──────────────────────────────────────────────────────────
  function _systemTheme() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark" : "light";
  }

  function _effectiveTheme() {
    return localStorage.getItem(STORAGE_KEY) || _systemTheme();
  }

  function _applyAttr(theme) {
    document.documentElement.setAttribute(ATTR_NAME, theme);
    _syncBgCards();
    window.dispatchEvent(new CustomEvent("clacky-theme-change", { detail: { theme } }));
  }

  // Update active state on all .settings-bg-theme-card buttons.
  function _syncBgCards() {
    const effective = current();
    document.querySelectorAll(".settings-bg-theme-card").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.bgTheme === effective);
    });
  }

  // ── Public API ───────────────────────────────────────────────────────
  function init() {
    _applyAttr(_effectiveTheme());

    // Live-follow OS changes when user has no manual override.
    if (window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => {
        if (!localStorage.getItem(STORAGE_KEY)) {
          _applyAttr(_systemTheme());
        }
      };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange); // Safari < 14
    }
  }

  // Apply any theme (light | dark | dim | warm).
  function apply(theme) {
    // If the chosen theme matches OS default, no need to persist
    if (theme === _systemTheme()) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, theme);
    }
    _applyAttr(theme);
  }

  // Keep applyBg as alias for backward compat (settings.js calls it)
  function applyBg(theme) {
    apply(theme);
  }

  function current() {
    return document.documentElement.getAttribute(ATTR_NAME) || _systemTheme();
  }

  return { init, apply, applyBg, current };
})();

// Initialize theme on page load
Theme.init();
