// ── ModelTester · view — render-free feature ──────────────────────────────
//
// ModelTester is a shared network helper with no panel of its own: the
// onboarding wizard and the settings model modal own the UI and call
// ModelTester.testConnection / saveModel directly. There is nothing to render
// here. This file exists to satisfy the store/view layering convention.
// ───────────────────────────────────────────────────────────────────────────
