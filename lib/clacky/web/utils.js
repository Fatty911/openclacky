// Cross-browser IME composition guard for Enter-to-submit inputs.
//
// Problem: pressing Enter to confirm an IME composition (e.g. selecting a
// Chinese candidate) must NOT trigger submit. Different browsers signal this
// differently:
//   - Chrome / Firefox / Edge: e.isComposing === true on the confirming Enter
//   - Older browsers: e.keyCode === 229
//   - Safari: fires compositionend ~5ms BEFORE keydown, so isComposing is
//     already false. We need a recent compositionend timestamp to suppress.
//
// Reference: https://bugs.webkit.org/show_bug.cgi?id=165004
//
// Usage:
//   IME.bindEnter(inputEl, () => submit());
//
// Or low-level for handlers that already own a keydown listener:
//   const ime = IME.track(inputEl);
//   inputEl.addEventListener("keydown", e => {
//     if (e.key === "Enter" && !ime.isComposing(e)) submit();
//   });
const IME = (() => {
  const SAFARI_GUARD_MS = 20;

  function track(inputEl) {
    let lastCompositionEnd = -Infinity;
    const onEnd = () => { lastCompositionEnd = Date.now(); };
    inputEl.addEventListener("compositionend", onEnd);

    return {
      isComposing(e) {
        if (e.isComposing || e.keyCode === 229) return true;
        return Date.now() - lastCompositionEnd <= SAFARI_GUARD_MS;
      },
      dispose() {
        inputEl.removeEventListener("compositionend", onEnd);
      }
    };
  }

  function bindEnter(inputEl, handler, options = {}) {
    const ime = track(inputEl);
    const onKey = (e) => {
      if (e.key !== "Enter") return;
      if (options.allowShift !== true && e.shiftKey) return;
      if (ime.isComposing(e)) return;
      e.preventDefault();
      handler(e);
    };
    inputEl.addEventListener("keydown", onKey);
    return () => {
      inputEl.removeEventListener("keydown", onKey);
      ime.dispose();
    };
  }

  return { track, bindEnter };
})();
