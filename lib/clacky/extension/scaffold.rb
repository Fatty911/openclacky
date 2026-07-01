# frozen_string_literal: true

require "fileutils"

module Clacky
  # Scaffolds and packs extension containers for the `ext new` / `ext pack`
  # commands. Generated containers are complete, runnable examples — the best
  # documentation for an AI author is a working "hello panel" it can copy.
  module ExtensionScaffold
    WEBUI_EXT_DIR = File.expand_path("~/.clacky/webui_ext")

    class << self
      # Create a new local container with a runnable hello panel + backend.
      # @param full [Boolean] when true, generate a "kitchen-sink" container
      #   exercising all 7 contributes types (panels, api, skills, agents,
      #   channels, patches, hooks) — useful as a learn-by-example reference.
      # @return [String] path to the created container directory
      def new_container(id, dir: Clacky::ExtensionLoader::LOCAL_DIR, full: false)
        slug = slugify(id)
        raise ArgumentError, "invalid extension id: #{id.inspect}" if slug.empty?

        target = File.join(dir, slug)
        raise ArgumentError, "extension already exists: #{target}" if Dir.exist?(target)

        return new_full_container(slug, target) if full

        panel_dir = File.join(target, "panels", "hello")
        FileUtils.mkdir_p(panel_dir)

        File.write(File.join(target, Clacky::ExtensionLoader::MANIFEST), manifest(slug))
        File.write(File.join(panel_dir, "view.js"), panel_view(slug))
        File.write(File.join(panel_dir, "handler.rb"), panel_handler(slug))
        target
      end

      # Pack a legacy loose api extension (~/.clacky/api_ext/<id>/) into a
      # container. Move semantics: the source dir is removed after copying.
      # @return [String] path to the created container directory
      def pack_api(id, api_ext_dir: Clacky::ApiExtensionLoader::DEFAULT_DIR,
                   dir: Clacky::ExtensionLoader::LOCAL_DIR)
        slug = slugify(id)
        raise ArgumentError, "invalid extension id: #{id.inspect}" if slug.empty?

        src = File.join(api_ext_dir, id)
        handler = File.join(src, "handler.rb")
        raise ArgumentError, "no api extension at #{src}" unless File.file?(handler)
        reject_if_protected!(File.join(src, "meta.yml"))

        target = File.join(dir, slug)
        raise ArgumentError, "extension already exists: #{target}" if Dir.exist?(target)

        unit_dir = File.join(target, "api", slug)
        FileUtils.mkdir_p(unit_dir)
        FileUtils.cp(handler, File.join(unit_dir, "handler.rb"))
        meta = File.join(src, "meta.yml")
        FileUtils.cp(meta, File.join(unit_dir, "meta.yml")) if File.file?(meta)

        File.write(File.join(target, Clacky::ExtensionLoader::MANIFEST), api_manifest(slug))
        FileUtils.rm_rf(src)
        target
      end

      # Pack a legacy loose WebUI extension (~/.clacky/webui_ext/<name>.js) into
      # a container. Move semantics: the source file is removed after copying.
      # @return [String] path to the created container directory
      def pack_webui(name, webui_ext_dir: WEBUI_EXT_DIR,
                     dir: Clacky::ExtensionLoader::LOCAL_DIR)
        base = name.delete_suffix(".js")
        slug = slugify(base)
        raise ArgumentError, "invalid extension id: #{name.inspect}" if slug.empty?

        src = File.join(webui_ext_dir, "#{base}.js")
        raise ArgumentError, "no webui extension at #{src}" unless File.file?(src)

        target = File.join(dir, slug)
        raise ArgumentError, "extension already exists: #{target}" if Dir.exist?(target)

        panel_dir = File.join(target, "panels", slug)
        FileUtils.mkdir_p(panel_dir)
        FileUtils.cp(src, File.join(panel_dir, "view.js"))

        File.write(File.join(target, Clacky::ExtensionLoader::MANIFEST), webui_manifest(slug))
        FileUtils.rm_f(src)
        target
      end

      private def reject_if_protected!(meta_path)
        return unless File.file?(meta_path)

        data = ::YAMLCompat.load_file(meta_path) || {}
        return unless data.is_a?(Hash) && data["protected"]

        raise ArgumentError, "refusing to pack a protected extension"
      end

      private def api_manifest(slug)
        <<~YAML
          id: #{slug}
          name: #{slug}
          origin: self
          contributes:
            api:
              - id: #{slug}
                handler: api/#{slug}/handler.rb
        YAML
      end

      private def webui_manifest(slug)
        <<~YAML
          id: #{slug}
          name: #{slug}
          origin: self
          contributes:
            panels:
              - id: #{slug}
                view: panels/#{slug}/view.js
                scope: global
        YAML
      end

      private def slugify(id)
        id.to_s.strip.downcase.gsub(/[^a-z0-9_-]+/, "-").gsub(/\A-+|-+\z/, "")
      end

      private def manifest(slug)
        <<~YAML
          id: #{slug}
          name: #{slug}
          description: (describe what this extension does)
          origin: self
          contributes:
            panels:
              - id: hello
                view: panels/hello/view.js
                api: panels/hello/handler.rb
                scope: global          # global | agent:<name>
        YAML
      end

      private def panel_view(slug)
        <<~JS
          // Hello panel for the "#{slug}" extension.
          // Mounts a tab in the session aside; talks to its backend at
          // /api/ext/#{slug}/hello/. Reload the WebUI page to see edits.
          (function () {
            Clacky.ext.ui.mount("session.aside", function (ctx) {
              var el = document.createElement("div");
              el.style.padding = "16px";

              var btn = document.createElement("button");
              btn.textContent = "Ping backend";
              var out = document.createElement("pre");

              btn.addEventListener("click", async function () {
                var res = await fetch("/api/ext/#{slug}/hello/");
                out.textContent = JSON.stringify(await res.json(), null, 2);
              });

              el.appendChild(btn);
              el.appendChild(out);
              return el;
            }, {
              tab: { id: "#{slug}", label: () => "#{slug}" },
              order: 500,
            });
          })();
        JS
      end

      private def panel_handler(slug)
        const = slug.split(/[-_]/).map(&:capitalize).join + "Ext"
        <<~RUBY
          # frozen_string_literal: true

          # Backend for the "hello" panel of "#{slug}". Mounted at
          # /api/ext/#{slug}/hello/. Routes here are relative to that mount.
          class #{const} < Clacky::ApiExtension
            get "/" do
              json(message: "hello from #{slug}")
            end
          end
        RUBY
      end

      # ---- "full" / kitchen-sink scaffold -----------------------------------
      # Generates a runnable container exercising every contributes type at
      # once. Each unit is intentionally minimal so the file you copy-paste
      # next is small and obvious.

      private def new_full_container(slug, target)
        panel_dir = File.join(target, "panels", "dashboard")
        skill_dir = File.join(target, "skills", "#{slug}-skill")
        api_dir   = File.join(target, "api")
        agents_dir = File.join(target, "agents")
        channels_dir = File.join(target, "channels")
        patches_dir = File.join(target, "patches")
        hooks_dir = File.join(target, "hooks")
        [panel_dir, skill_dir, api_dir, agents_dir, channels_dir, patches_dir, hooks_dir].each do |d|
          FileUtils.mkdir_p(d)
        end

        File.write(File.join(target, Clacky::ExtensionLoader::MANIFEST), full_manifest(slug))
        File.write(File.join(panel_dir, "view.js"),     full_panel_view(slug))
        File.write(File.join(panel_dir, "handler.rb"),  full_panel_handler(slug))
        File.write(File.join(api_dir,   "stats.rb"),    full_api_handler(slug))
        File.write(File.join(skill_dir, "SKILL.md"),    full_skill_md(slug))
        File.write(File.join(agents_dir, "designer.md"), full_agent_prompt(slug))
        File.write(File.join(channels_dir, "noop.rb"),  full_channel_adapter(slug))
        File.write(File.join(patches_dir, "audit.rb"),  full_patch_file(slug))
        File.write(File.join(hooks_dir,   "audit.rb"),  full_hook_file(slug))
        File.write(File.join(target, "README.md"),      full_readme(slug))
        target
      end

      private def full_manifest(slug)
        <<~YAML
          id: #{slug}
          name: #{slug}
          description: Kitchen-sink reference container — exercises all 7 contributes types.
          version: "0.1.0"
          origin: self
          contributes:
            panels:
              - id: dashboard
                title: Dashboard
                view: panels/dashboard/view.js
                api: panels/dashboard/handler.rb
                scope: agent:designer        # only visible to the `designer` agent below
            api:
              - id: stats
                handler: api/stats.rb        # mounted at /api/ext/#{slug}/stats
            skills:
              - id: #{slug}-skill            # SKILL.md under skills/#{slug}-skill/
            agents:
              - id: designer
                title: Designer
                description: A demo agent that owns the dashboard panel and the #{slug}-skill skill.
                prompt: agents/designer.md
                panels: [dashboard]
                skills: [#{slug}-skill]
            channels:
              - id: noop
                adapter: channels/noop.rb
            patches:
              # Patches monkey-patch real classes. The example target is a
              # real, live method — Terminal#execute is called for every
              # shell tool invocation. Omit `fingerprint:` to trust the patch
              # (loader will require the file directly); provide one to have
              # the loader disable/warn if upstream source drifts.
              - target: "Clacky::Tools::Terminal#execute"
                file: patches/audit.rb
            hooks:
              - event: before_tool_use
                file: hooks/audit.rb
        YAML
      end

      private def full_panel_view(slug)
        <<~JS
          // Dashboard panel + demo UI hooks for the "#{slug}" extension.
          // One file, six slots + one workspace — a tour of every UI hook:
          //   • sidebar.nav.top    — top-of-rail entry for a first-class workspace
          //   • sidebar.nav        — regular menu entry (between Sessions and Config)
          //   • sidebar.nav.bottom — end-of-rail entry for a secondary link
          //   • main.workspace     — a full-page view opened by those entries
          //   • session.banner     — a strip above the message list
          //   • session.aside      — a tab in the right aside
          //   • session.composer   — quick-action buttons above the input bar
          // Reload the WebUI page to see edits.
          (function () {
            var EXT = "#{slug}";

            // ── 0. Full-page workspace: a "console" view mounted in #main.
            //   Registered once; opened via openWorkspace(id) below or by
            //   navigating to #ext/#{slug}. Router hides other panels first,
            //   then calls render(container) — container is empty on entry.
            Clacky.ext.ui.registerWorkspace(EXT, {
              title: EXT + " console",
              render: function (container) {
                container.innerHTML =
                  '<div style="max-width:720px;margin:32px auto;padding:24px;">' +
                    '<h2 style="margin:0 0 8px">' + EXT + ' console</h2>' +
                    '<p style="opacity:.7;margin:0 0 16px">' +
                      'Full-page workspace registered by the ' + EXT + ' extension. ' +
                      'Replace this render() with a real dashboard, form, or embedded iframe.' +
                    '</p>' +
                    '<button id="ws-load-stats">Load stats</button>' +
                    '<pre id="ws-out" style="margin-top:12px"></pre>' +
                  '</div>';
                container.querySelector("#ws-load-stats").addEventListener("click", async function () {
                  var res = await fetch("/api/ext/" + EXT + "/stats/");
                  container.querySelector("#ws-out").textContent =
                    JSON.stringify(await res.json(), null, 2);
                });
              },
            });

            // Shared factory for a sidebar row (icon + label + click handler).
            function navRow(label, onClick) {
              var item = document.createElement("div");
              item.className = "task-item task-item-summary";
              item.innerHTML =
                '<div class="task-row">' +
                  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" ' +
                       'fill="none" stroke="currentColor" stroke-width="2" ' +
                       'stroke-linecap="round" stroke-linejoin="round" class="task-icon">' +
                    '<rect x="3" y="3" width="7" height="7"/>' +
                    '<rect x="14" y="3" width="7" height="7"/>' +
                    '<rect x="3" y="14" width="7" height="7"/>' +
                    '<rect x="14" y="14" width="7" height="7"/>' +
                  '</svg>' +
                  '<div class="task-info"><span class="task-name">' + label + '</span></div>' +
                '</div>';
              item.addEventListener("click", onClick);
              return item;
            }

            // ── 1a. Top slot: first-class workspace entry, above Sessions ──
            //   Global chrome — visible for every agent regardless of the
            //   panel file this mount lives in.
            Clacky.ext.ui.mount("sidebar.nav.top", function () {
              return navRow(EXT + " console", function () {
                Clacky.ext.ui.openWorkspace(EXT);
              });
            });

            // ── 1b. Main slot: regular menu row between Sessions and Config ─
            Clacky.ext.ui.mount("sidebar.nav", function () {
              return navRow(EXT + " menu (middle)", function () {
                Clacky.ext.ui.openWorkspace(EXT);
              });
            });

            // ── 1c. Bottom slot: secondary link at the end of the rail ─────
            Clacky.ext.ui.mount("sidebar.nav.bottom", function () {
              return navRow(EXT + " footer link", function () {
                Clacky.ext.ui.openWorkspace(EXT);
              });
            });

            // ── 2. Session banner: horizontal strip above the messages ─────
            Clacky.ext.ui.mount("session.banner", function () {
              var bar = document.createElement("div");
              bar.style.cssText =
                "padding:8px 12px;margin:8px 0;border-radius:6px;" +
                "background:var(--accent-soft,#eef);color:var(--accent,#334);" +
                "display:flex;align-items:center;gap:8px;font-size:13px;";
              bar.innerHTML = '<strong>' + EXT + '</strong> — banner slot demo. ';
              var dismiss = document.createElement("button");
              dismiss.textContent = "Dismiss";
              dismiss.style.cssText = "margin-left:auto;font-size:12px;";
              dismiss.addEventListener("click", function () { bar.remove(); });
              bar.appendChild(dismiss);
              return bar;
            });

            // ── 3. Session aside: a tab in the right column (tabbed slot) ──
            Clacky.ext.ui.mount("session.aside", function (ctx) {
              var el = document.createElement("div");
              el.style.padding = "16px";
              el.innerHTML = '<h3 style="margin:0 0 8px">' + EXT + ' dashboard</h3>';

              var btn = document.createElement("button");
              btn.textContent = "Load stats";
              var out = document.createElement("pre");

              btn.addEventListener("click", async function () {
                var res = await fetch("/api/ext/" + EXT + "/stats/");
                out.textContent = JSON.stringify(await res.json(), null, 2);
              });

              el.appendChild(btn);
              el.appendChild(out);
              return el;
            }, {
              tab: { id: EXT, label: () => EXT },
              order: 500,
            });

            // ── 4. Session composer: quick-action buttons above the input ──
            //   Clicking a button injects a slash command into #user-input
            //   and clicks #btn-send — the same code path as typing it.
            Clacky.ext.ui.mount("session.composer", function () {
              var wrap = document.createElement("div");
              wrap.style.cssText = "display:flex;gap:6px;padding:6px 8px;flex-wrap:wrap;";

              function quick(label, command) {
                var b = document.createElement("button");
                b.type = "button";
                b.textContent = label;
                b.style.cssText =
                  "padding:4px 10px;font-size:12px;border-radius:14px;" +
                  "border:1px solid var(--border,#ccc);background:var(--surface,#fff);cursor:pointer;";
                b.addEventListener("click", function () {
                  var input = document.getElementById("user-input");
                  var send  = document.getElementById("btn-send");
                  if (!input || !send) return;
                  input.value = command;
                  input.dispatchEvent(new Event("input", { bubbles: true }));
                  send.click();
                });
                return b;
              }

              wrap.appendChild(quick("Say hi", "/" + EXT + "-skill hi"));
              wrap.appendChild(quick("Explain code", "/" + EXT + "-skill explain the current file"));
              return wrap;
            });
          })();
        JS
      end

      private def full_panel_handler(slug)
        const = full_const(slug, "Dashboard")
        <<~RUBY
          # frozen_string_literal: true

          # Per-panel backend for the dashboard panel of "#{slug}".
          # Mounted at /api/ext/#{slug}/dashboard/. Routes are relative.
          class #{const} < Clacky::ApiExtension
            get "/" do
              json(panel: "dashboard", at: Time.now.utc.iso8601)
            end
          end
        RUBY
      end

      private def full_api_handler(slug)
        const = full_const(slug, "Stats")
        <<~RUBY
          # frozen_string_literal: true

          # Standalone api unit. Mounted at /api/ext/#{slug}/stats/.
          class #{const} < Clacky::ApiExtension
            get "/" do
              json(uptime: Process.clock_gettime(Process::CLOCK_MONOTONIC).round(2))
            end
          end
        RUBY
      end

      private def full_skill_md(slug)
        <<~MD
          ---
          name: #{slug}-skill
          description: Demo skill contributed by the "#{slug}" extension. Greets in style.
          ---

          You are the #{slug} demo skill.

          When the user asks for a greeting, respond with one short, friendly line.
        MD
      end

      private def full_agent_prompt(_slug)
        <<~MD
          You are **Designer**, a demo agent shipped by this extension.

          Your job is to help the user iterate on visual design. You have a
          dashboard panel mounted in the WebUI session aside. Use it to surface
          information rather than dumping it into chat.
        MD
      end

      private def full_channel_adapter(slug)
        const = full_const(slug, "Noop") + "Adapter"
        <<~RUBY
          # frozen_string_literal: true

          # Demo channel adapter for `:#{slug}_noop`. It doesn't actually
          # connect anywhere — it exists to show the wiring. Real adapters
          # (see the built-in Feishu / WeCom / Telegram / Discord ones) open
          # a long-poll or webhook and translate messages both ways.
          module Clacky
            module Channel
              module Adapters
                class #{const} < Base
                  def self.platform_id
                    :#{slug}_noop
                  end

                  def self.platform_config(_data)
                    {}
                  end

                  def initialize(config)
                    @config = config
                  end

                  def start(&_on_message)
                    # TODO: connect to your platform and yield events.
                  end

                  def stop
                    # TODO: tear down connections.
                  end

                  def send_text(_chat_id, text, reply_to: nil)
                    Clacky::Logger.info("[#{slug}_noop] would send: \#{text}")
                    { message_id: "noop-\#{Time.now.to_i}" }
                  end
                end

                register(#{const}.platform_id, #{const})
              end
            end
          end
        RUBY
      end

      private def full_patch_file(_slug)
        <<~RUBY
          # frozen_string_literal: true

          # Example monkey-patch. Prepends onto Clacky::Tools::Terminal#execute
          # so we get one log line per shell tool invocation.
          # In production a patch might enforce a denylist, rewrite arguments,
          # or measure timing. Keep the body small and always call `super`.
          module ExtSampleAuditPatch
            def execute(*args, **kwargs)
              cmd = kwargs[:command] || args.first
              Clacky::Logger.info("[ext-audit] terminal.execute", command: cmd.to_s[0, 200])
              super
            end
          end

          Clacky::Tools::Terminal.prepend(ExtSampleAuditPatch)
        RUBY
      end

      private def full_hook_file(_slug)
        <<~RUBY
          # frozen_string_literal: true

          # Hook callbacks contributed by this extension. The block is copied
          # onto each agent's HookManager at agent init time. The event name
          # comes from ext.yml — no need to repeat it here.
          Clacky::ExtensionHookRegistry.add do |tool_name, args|
            Clacky::Logger.debug("[ext-hook] before_tool_use", tool: tool_name)
            { action: :allow }
          end
        RUBY
      end

      private def full_readme(slug)
        <<~MD
          # #{slug}

          Kitchen-sink reference extension generated by `clacky ext new --full`.
          It exercises every `contributes` type at once so you can copy-paste
          the parts you actually need into a real extension.

          ## Contents

          - `panels/dashboard/` — WebUI panel + per-panel backend. Its
            `view.js` also demonstrates every UI hook at once:
            a full-page workspace opened from three sidebar slots
            (`sidebar.nav.top` above Sessions, `sidebar.nav` between
            Sessions and Config, `sidebar.nav.bottom` at the end of the
            rail — hash `#ext/#{slug}`), plus `session.banner`,
            `session.aside`, and `session.composer` (quick-action
            buttons that submit slash commands).
          - `api/stats.rb`      — standalone HTTP endpoint at `/api/ext/#{slug}/stats`
          - `skills/#{slug}-skill/SKILL.md` — a skill contributed to the agent
          - `agents/designer.md` — a custom agent (`--agent designer`) that owns the panel + skill
          - `channels/noop.rb`  — a no-op IM channel adapter (`:#{slug}_noop`)
          - `patches/audit.rb`  — a monkey-patch on `Clacky::Tools::Terminal#execute`
          - `hooks/audit.rb`    — a `before_tool_use` hook callback

          ## Verify

          ```bash
          clacky ext verify       # schema + reference integrity check
          clacky ext list         # see all 7 units listed under #{slug}
          ```

          ## Try it

          - Reload the WebUI page → three sidebar entries appear:
            **#{slug} console** at the top, **#{slug} menu (middle)** between
            Sessions and Config, **#{slug} footer link** at the very bottom
            (all global; every agent sees them)
          - Click any of them → main area switches to the full-page workspace at `#ext/#{slug}` (Load stats works)
          - Switch to the `designer` agent → see the **#{slug}** tab in the aside, plus a banner and quick-action buttons above the input
          - Click a quick-action button → it fills `#user-input` with `/#{slug}-skill …` and submits
          - `clacky --agent designer "say hi"` — uses the contributed skill
          - Run any tool from chat → see `[ext-hook] before_tool_use` in the log
          - Run a shell tool → see `[ext-audit] terminal.execute` from the patch

          ## Trim it down

          When you know which contributes types you actually want, delete the
          others (and remove their entries from `ext.yml`). `clacky ext verify`
          will tell you if anything is left dangling.
        MD
      end

      private def full_const(slug, suffix)
        slug.split(/[-_]/).map(&:capitalize).join + suffix
      end
    end
  end
end
