---
name: extend-openclacky
description: Customize, fix, override or extend openclacky itself — change a built-in tool's behavior, intercept/audit/block tool calls, plug in a new IM channel (Slack, in-house IM…), or add UI to the Web UI (panel, button, settings tab). Trigger on "patch openclacky", "block dangerous commands", "audit tool use", "add Slack channel", "extend the web ui", "改 openclacky 内置", "拦截工具调用", "扩展 web 界面". Do NOT trigger for ordinary feature work in the user's own project that doesn't touch openclacky.
---

# Extending Openclacky

Openclacky ships four official extension mechanisms that survive `gem update` and never require editing the gem source.
**Never tell the user to `bundle show openclacky` and edit the gem — always use one of these.**

## Pick the right mechanism

| User wants to… | Use | Scaffold | Verify |
|---|---|---|---|
| Change behavior of an **existing method** in openclacky (e.g. `WebSearch#execute` timeout, fix a bug in a built-in tool) | **Patch** | `clacky patch_new <id> "Const#method" -d "<desc>"` | `clacky patch_verify` |
| **Audit / block / observe** tool calls (block `rm -rf /`, log every shell command) — no Ruby needed | **Shell Hook** | `clacky hook_new <id> -e <event>` | `clacky hook_verify` |
| Plug openclacky into a **new IM platform** (Slack, in-house IM, custom webhook…) | **Channel Adapter** | `clacky channel_new <platform_id>` | `clacky channel_verify` |
| Add UI to the **Web UI** (custom panel, header button, settings tab, visualize data) | **Web UI Extension** | drop a `.js` file in `~/.clacky/webui_ext/` | reload page; `Clacky.ext.slots()` in console; `?pure=true` to escape |

## Authoritative documentation

Each mechanism has a full reference doc — read the relevant one with `web_fetch` before writing code:

- Patches → https://www.openclacky.com/docs/extend-patches
- Shell Hooks → https://www.openclacky.com/docs/extend-shell-hooks
- Channel Adapters → https://www.openclacky.com/docs/extend-channel-adapter
- Web UI Extensions → https://www.openclacky.com/docs/extend-webui

## Execution playbook

1. **Identify** which mechanism fits (use the table above; ask if genuinely ambiguous).
2. **Read the doc** for that mechanism with `web_fetch`. Don't guess fields, hook events, or required methods — the doc is the contract.
3. **Run the scaffold** CLI command. It generates the file(s) in `~/.clacky/...` with correct meta. *(Web UI Extensions have no scaffold — just create a `.js` file under `~/.clacky/webui_ext/`; the doc shows the `Clacky.ext` contract.)*
4. **Edit** the generated file to implement the user's intent. Keep generated meta fields (`target`, `event`, `platform_id`, the `Clacky::ChannelRegistry.register(...)` line, etc.) intact unless the doc says otherwise.
5. **Verify** with the matching `*_verify` command. Surface any `[FAIL]` lines to the user verbatim. *(Web UI Extensions have no verify command — reload the page and confirm the slot rendered; if anything breaks, `?pure=true` disables all extensions instantly.)*

## When NOT to use this skill

- The user is building features in their own application that just *use* openclacky — that's normal coding, no patch/hook/channel needed.
- The user wants a brand-new tool/skill for *their* project — use `.clacky/skills/` or `.clacky/tools/`, not these gem-level mechanisms.
- The change can be made via `clacky config set ...` — prefer config over patches.
