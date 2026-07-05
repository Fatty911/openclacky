---
name: ext-publish
description: Pack and publish an OpenClacky extension to the marketplace, publish a new version, list published extensions, or unpublish one. Use when the user wants to ship, release, publish, update, or take down an extension. Handles packing, the license requirement, versioning, and the already-published case.
---

# Extension Publish

Take a finished local extension and ship it to the OpenClacky marketplace, then confirm
it's live.

## Before publishing

- The extension must live in the **local** layer (`~/.clacky/ext/local/<id>/`). Only
  local containers can be packed. Marketplace-origin and encrypted (`SKILL.md.enc`)
  containers are rejected.
- Publishing requires an **activated user license** — it proves creator identity, and
  the platform attributes the extension to that account. If activation is missing, tell
  the user to activate first; don't try to work around it.
- Run `clacky ext verify` one last time and confirm no errors before shipping.

## Publish (first time)

```
clacky ext publish <id>
```

This packs the local container into a zip and uploads it. On success you'll see:

```
Published <id> v<version> → status=<status>
```

Options:
- `--status draft` — publish as a draft (not yet visible on the public marketplace).
  Omit or use `--status published` to go live.
- `--changelog "..."` — release notes for this version.

## Publish a new version

If the extension is already published, a plain `publish` fails with:

```
Error: <id> already published. Re-run with --force to publish a new version.
```

Re-run with `--force` (and ideally a `--changelog`) to publish a new version. The patch
version auto-increments on the platform side.

```
clacky ext publish <id> --force --changelog "Fixed the weather refresh bug"
```

## List your published extensions

```
clacky ext published
```

Shows each extension with its latest version, status, and unit summary.

## Unpublish

```
clacky ext unpublish <id>
```

Soft-deletes (takes down) one of your published extensions. Confirm with the user
before doing this — it removes it from the marketplace.

## Wrap up

After a successful publish, tell the user the version and status in plain terms, and
mention they can run `clacky ext published` to see it in their list, or bump a new
version anytime with `--force`.
