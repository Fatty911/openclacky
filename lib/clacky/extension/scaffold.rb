# frozen_string_literal: true

require "fileutils"

module Clacky
  # Scaffolds and packs extension containers for the `ext new` / `ext pack`
  # commands. Generated containers are complete, runnable examples — the best
  # documentation for an AI author is a working "hello panel" it can copy.
  module ExtensionScaffold
    WEBUI_EXT_DIR    = File.expand_path("~/.clacky/webui_ext")
    TEMPLATES_DIR    = File.expand_path("scaffold/templates", __dir__)

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

        FileUtils.mkdir_p(target)
        TemplateRenderer.render(
          template_dir: File.join(TEMPLATES_DIR, "hello"),
          target: target,
          locals: { slug: slug, const_prefix: camelize(slug) }
        )
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

        TemplateRenderer.render(
          template_dir: File.join(TEMPLATES_DIR, "pack_api"),
          target: target,
          locals: { slug: slug }
        )
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

        TemplateRenderer.render(
          template_dir: File.join(TEMPLATES_DIR, "pack_webui"),
          target: target,
          locals: { slug: slug }
        )
        FileUtils.rm_f(src)
        target
      end

      private def reject_if_protected!(meta_path)
        return unless File.file?(meta_path)

        data = ::YAMLCompat.load_file(meta_path) || {}
        return unless data.is_a?(Hash) && data["protected"]

        raise ArgumentError, "refusing to pack a protected extension"
      end

      private def slugify(id)
        id.to_s.strip.downcase.gsub(/[^a-z0-9_-]+/, "-").gsub(/\A-+|-+\z/, "")
      end

      private def camelize(slug)
        slug.split(/[-_]/).map(&:capitalize).join
      end

      # ---- "full" / kitchen-sink scaffold -----------------------------------
      # Generates a runnable container exercising every contributes type at
      # once. Each unit is intentionally minimal so the file you copy-paste
      # next is small and obvious.

      private def new_full_container(slug, target)
        FileUtils.mkdir_p(target)
        TemplateRenderer.render(
          template_dir: File.join(TEMPLATES_DIR, "full"),
          target: target,
          locals: { slug: slug, const_prefix: camelize(slug) }
        )
        target
      end
    end
  end
end

