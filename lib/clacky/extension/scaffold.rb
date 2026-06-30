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
                platform: #{slug}_noop
                adapter: channels/noop.rb
            patches:
              # Patches are a power tool: they monkey-patch real classes.
              # The example target is harmless — it just adds an audit log line.
              # Drop `fingerprint:` to trust the patch unconditionally, or run
              # `clacky patch_verify` to compute one and freeze it.
              - target: "Clacky::Tools::Shell#run"
                file: patches/audit.rb
                on_mismatch: warn
            hooks:
              - event: before_tool_use
                file: hooks/audit.rb
        YAML
      end

      private def full_panel_view(slug)
        <<~JS
          // Dashboard panel for the "#{slug}" extension.
          // Mounts a tab in the session aside; talks to its backend at
          // /api/ext/#{slug}/dashboard/. Reload the WebUI page to see edits.
          (function () {
            Clacky.ext.ui.mount("session.aside", function (ctx) {
              var el = document.createElement("div");
              el.style.padding = "16px";
              el.innerHTML = '<h3 style="margin:0 0 8px">#{slug} dashboard</h3>';

              var btn = document.createElement("button");
              btn.textContent = "Load stats";
              var out = document.createElement("pre");

              btn.addEventListener("click", async function () {
                var res = await fetch("/api/ext/#{slug}/stats/");
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

          # Demo channel adapter for ":#{slug}_noop". Does nothing useful; it
          # exists to show the wiring. Real adapters connect to Slack, Feishu,
          # etc. and translate inbound/outbound messages.
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
                    # TODO: connect to your platform and loop, calling on_message
                  end

                  def stop
                    # TODO: tear down connections
                  end

                  def send_text(_chat_id, text, reply_to: nil)
                    Clacky::Logger.info("[#{slug}_noop] would send: \#{text}")
                    { message_id: "noop-\#{Time.now.to_i}" }
                  end

                  Adapters.register(platform_id, self)
                end
              end
            end
          end
        RUBY
      end

      private def full_patch_file(_slug)
        <<~RUBY
          # frozen_string_literal: true

          # Example monkey-patch. Targets Clacky::Tools::Shell#run and just logs
          # every shell invocation. In real life you might enforce a denylist,
          # rewrite arguments, or measure timing.
          module ExtSampleAuditPatch
            def run(*args, **kwargs)
              Clacky::Logger.info("[ext-audit] shell.run", args: args.first(2))
              super
            end
          end

          if defined?(Clacky::Tools::Shell)
            Clacky::Tools::Shell.prepend(ExtSampleAuditPatch)
          end
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

          - `panels/dashboard/` — WebUI panel + per-panel backend
          - `api/stats.rb`      — standalone HTTP endpoint at `/api/ext/#{slug}/stats`
          - `skills/#{slug}-skill/SKILL.md` — a skill contributed to the agent
          - `agents/designer.md` — a custom agent (`--agent designer`) that owns the panel + skill
          - `channels/noop.rb`  — a no-op IM channel adapter (`:#{slug}_noop`)
          - `patches/audit.rb`  — a monkey-patch on `Clacky::Tools::Shell#run`
          - `hooks/audit.rb`    — a `before_tool_use` hook callback

          ## Verify

          ```bash
          clacky ext verify       # schema + reference integrity check
          clacky ext list         # see all 7 units listed under #{slug}
          ```

          ## Try it

          - Reload the WebUI page → switch to the `designer` agent → see the **#{slug}** tab in the aside
          - `clacky --agent designer "say hi"` — uses the contributed skill
          - Run any tool from chat → see `[ext-hook] before_tool_use` in the log
          - Run a shell tool → see `[ext-audit] shell.run` from the patch

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
