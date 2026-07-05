---
name: ext-debug
description: Debug an OpenClacky extension that won't load, throws errors, or whose panel/api/skill/agent isn't showing up. Use when the user reports something broken with their extension, when `clacky ext verify` reports issues, or when a change didn't take effect. Reads structured verify errors and fixes manifest and file problems.
---

# Extension Debug

Diagnose and fix a broken extension. Your primary instrument is `clacky ext verify` —
it's a compiler for extensions: every issue is structured with a `code`, `message`,
the offending `file`, and a `hint` telling you how to fix it.

## Step 1 — Run verify

```
clacky ext verify
```

Read the output line by line. `[OK]` lines confirm resolved units. `[ERR]` blocks a
load; `[WARN]` is advisory. Each issue looks like:

```
[ERR] <ext> <unit> (<code>) — <message> [<file>]
         hint: <how to fix>
```

## Step 2 — Fix by error code

- **`loader.error`** — a file the manifest points at is missing or the container
  couldn't be parsed. Check the `file` path exists and `ext.yml` is valid YAML. A skill
  needs `SKILL.md` under `skills/<id>/`; an agent needs its `prompt` file; a panel needs
  its `view` file; api needs `api/handler.rb`.
- **`schema.unknown_contributes`** — a top-level key under `contributes:` isn't one of
  `panels api skills agents channels patches hooks`. Fix the spelling.
- **`schema.unknown_field` / `schema.unknown_key`** — a unit has a field that isn't
  allowed for its type. Remove or rename it. Allowed fields:
  - panel: `id title title_zh description description_zh view order attach`
  - api: `id handler`
  - skill: `id dir protected`
  - agent: `id title title_zh description description_zh order prompt panels skills`
  - channel: `id platform adapter`
- **`schema.bad_attach`** — a panel `attach:` entry isn't a valid token. Use agent ids
  or `"*"` for all.
- **`ref.missing_panel`** — an agent references `panels: [id]` that no panel provides.
  Fix the id, or use `<ext_id>/<panel_id>` to reference a panel in another extension.
- **`ref.missing_skill`** — an agent references `skills: [id]` that no skill provides.
  Fix the id or add the skill.
- **`ref.missing_attach_agent`** — a panel's `attach:` names an agent that doesn't
  exist. Fix the agent id.
- **`override`** (warning) — a unit in a higher layer is shadowing a lower one
  (`local > installed > builtin`). Usually intentional; confirm with the user if not.

Fix one issue, re-run verify, repeat until clean.

## Step 3 — "It verifies but doesn't show up"

If verify is clean but a change isn't visible:
- **Hot reload is per-request.** After editing `view.js`, `handler.rb`, or a `SKILL.md`,
  the user must **reload the WebUI page** — there's no restart, but a stale tab won't
  update on its own. Editing `ext.yml` also applies on the next load.
- **Panel not appearing?** Check the panel's `attach:` (or the agent that references it
  via `panels: [id]`). A panel with no `attach` and no referencing agent has nothing to
  mount onto.
- **API 404?** Routes are relative to `/api/ext/<ext_id>/`. Confirm the handler subclasses
  `Clacky::ApiExtension` and the route pattern matches what `view.js` fetches.
- **Skill not triggering?** The AI selects skills by their `description`. Make the
  description concrete about WHEN to use it.

## Step 4 — Confirm the fix

End with a clean `clacky ext verify` and have the user reload to confirm the behavior
actually works — don't declare success on "should work."
