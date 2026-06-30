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
      # @return [String] path to the created container directory
      def new_container(id, dir: Clacky::ExtensionLoader::LOCAL_DIR)
        slug = slugify(id)
        raise ArgumentError, "invalid extension id: #{id.inspect}" if slug.empty?

        target = File.join(dir, slug)
        raise ArgumentError, "extension already exists: #{target}" if Dir.exist?(target)

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
          // /api/ext/#{slug}/hello. Reload the WebUI page to see edits.
          (function () {
            Clacky.ext.ui.mount("session.aside", function (ctx) {
              var el = document.createElement("div");
              el.style.padding = "16px";

              var btn = document.createElement("button");
              btn.textContent = "Ping backend";
              var out = document.createElement("pre");

              btn.addEventListener("click", async function () {
                var res = await fetch("/api/ext/#{slug}/hello");
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

          # Backend for the "#{slug}" extension, mounted at /api/ext/#{slug}/.
          class #{const} < Clacky::ApiExtension
            get "/hello" do
              json(message: "hello from #{slug}")
            end
          end
        RUBY
      end
    end
  end
end
