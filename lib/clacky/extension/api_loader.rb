# frozen_string_literal: true

require "fileutils"

module Clacky
  # Loads HTTP API extensions from two sources into the shared
  # Clacky::ApiExtension registry, keyed by mount_id ("<ext_id>/<unit_id>"):
  #
  #   1. ext.yml containers (~/.clacky/ext/<layer>/<ext_id>/) — one container
  #      may contribute multiple api units (standalone + panel.api derived).
  #   2. Loose handlers at ~/.clacky/api_ext/<name>/handler.rb — single-unit
  #      shorthand; mount_id is "<name>/<name>".
  #   3. Built-in default_extensions/<name>/handler.rb — same shape as (2).
  #
  # A broken extension (syntax error, missing base class, route conflict) is
  # isolated: skipped with a logged warning, never aborts the load of others.
  module ApiExtensionLoader
    DEFAULT_DIR  = File.expand_path("~/.clacky/api_ext")
    BUILTIN_DIR  = File.expand_path("../default_extensions", __dir__)
    DISABLED_DIR = "_disabled"

    Result = Struct.new(:loaded, :skipped, keyword_init: true)

    class << self
      def load_all(dir: DEFAULT_DIR, builtin: true, reload: false)
        result = Result.new(loaded: [], skipped: [])
        Clacky::ApiExtension.reset_registry!
        handler_mtime_cache.clear

        if builtin && Dir.exist?(BUILTIN_DIR)
          Dir.glob(File.join(BUILTIN_DIR, "*", "handler.rb")).sort.each do |handler_path|
            ext_dir = File.dirname(handler_path)
            ext_id  = File.basename(ext_dir)
            next if ext_id.start_with?("_")
            load_one(ext_id, ext_id, ext_dir, handler_path, result, reload: reload)
          end
        end

        if Dir.exist?(dir)
          Dir.glob(File.join(dir, "*", "handler.rb")).sort.each do |handler_path|
            ext_dir = File.dirname(handler_path)
            ext_id  = File.basename(ext_dir)
            next if ext_id == DISABLED_DIR || ext_id.start_with?("_")
            load_one(ext_id, ext_id, ext_dir, handler_path, result, reload: reload)
          end
        end

        @last_result = result
        log_summary(result)
        result
      end

      def last_result
        @last_result || load_all
      end

      # Per-request hot path used by the dispatcher. Re-loads the handler
      # only when its file mtime has changed since the last load — a stat is
      # cheap, and skipping unchanged handlers keeps the request path clean.
      def ensure_fresh(mount_id)
        mid = Clacky::Extension::MountId.parse(mount_id.to_s)
        return unless mid

        path, ext_dir = resolve_handler(mid.ext_id, mid.unit_id)
        return unless path

        current_mtime = File.mtime(path).to_f
        cache = handler_mtime_cache
        return if cache[mid.to_s] == current_mtime

        r = Result.new(loaded: [], skipped: [])
        load_one(mid.ext_id, mid.unit_id, ext_dir, path, r, reload: true)
        r.skipped.each { |(id, reason)| log_skip(id, reason) }
        cache[mid.to_s] = current_mtime
      rescue StandardError => e
        Clacky::Logger.warn("[ApiExtensionLoader] ensure_fresh(#{mount_id}) failed: #{e.message}")
      end

      private def handler_mtime_cache
        @handler_mtime_cache ||= {}
      end

      private def resolve_handler(ext_id, unit_id)
        container = Clacky::ExtensionLoader.load_all.api.find do |u|
          u.ext_id == ext_id && u.id == unit_id
        end
        return [container.spec["handler_abs"], container.dir] if container

        if ext_id == unit_id
          loose = File.join(DEFAULT_DIR, ext_id, "handler.rb")
          return [loose, File.dirname(loose)] if File.file?(loose)

          builtin = File.join(BUILTIN_DIR, ext_id, "handler.rb")
          return [builtin, File.dirname(builtin)] if File.file?(builtin)
        end

        [nil, nil]
      end

      def load_one(ext_id, unit_id, ext_dir, handler_path, result, reload: false)
        mount_id = Clacky::Extension::MountId.new(ext_id, unit_id).to_s
        meta = read_meta(ext_dir)
        before = Clacky::ApiExtension.pending_subclasses.size

        existing = reload ? Clacky::ApiExtension.registry[mount_id] : nil
        existing&.reset_routes!

        if reload
          old_verbose = $VERBOSE
          $VERBOSE = nil
          begin
            load(handler_path)
          ensure
            $VERBOSE = old_verbose
          end
        else
          require(handler_path)
        end

        new_subclasses = Clacky::ApiExtension.pending_subclasses[before..] || []
        klass = new_subclasses.last || existing

        unless klass
          result.skipped << [mount_id, "no Clacky::ApiExtension subclass defined in handler.rb"]
          log_skip(mount_id, result.skipped.last[1])
          return
        end

        klass.ext_id  = ext_id
        klass.unit_id = unit_id
        klass.ext_dir = ext_dir
        klass.meta    = meta

        if klass.routes.empty?
          result.skipped << [mount_id, "no routes declared (use get/post/... DSL)"]
          log_skip(mount_id, result.skipped.last[1])
          Clacky::ApiExtension.registry.delete(mount_id)
          return
        end

        if (gap = validate_public_endpoints(klass, meta))
          result.skipped << [mount_id, gap]
          log_skip(mount_id, gap)
          return
        end

        Clacky::ApiExtension.register(mount_id, klass)
        result.loaded << mount_id
        handler_mtime_cache[mount_id] = File.mtime(handler_path).to_f rescue nil
        public_count = klass.public_paths.size
        suffix = public_count > 0 ? " (#{public_count} public)" : ""
        Clacky::Logger.info("[ApiExtensionLoader] Loaded '#{mount_id}' — #{klass.routes.size} route(s)#{suffix}")
      rescue StandardError, ScriptError => e
        result.skipped << [Clacky::Extension::MountId.new(ext_id, unit_id).to_s, e.message]
        log_skip(Clacky::Extension::MountId.new(ext_id, unit_id).to_s, e.message)
      end

      private def read_meta(ext_dir)
        path = File.join(ext_dir, "meta.yml")
        return {} unless File.exist?(path)

        YAMLCompat.load_file(path) || {}
      rescue StandardError => e
        Clacky::Logger.warn("[ApiExtensionLoader] Failed to read meta.yml in #{ext_dir}: #{e.message}")
        {}
      end

      private def validate_public_endpoints(klass, meta)
        return nil if klass.public_paths.empty?
        return nil if meta["public"] == true

        "uses public_endpoint but meta.yml is missing 'public: true'"
      end

      private def log_skip(mount_id, reason)
        Clacky::Logger.warn("[ApiExtensionLoader] Skipped '#{mount_id}': #{reason}")
      end

      private def log_summary(result)
        return if result.loaded.empty? && result.skipped.empty?

        total_routes = result.loaded.sum { |id| Clacky::ApiExtension.registry[id]&.routes&.size || 0 }
        Clacky::Logger.info("[ApiExtensionLoader] #{result.loaded.size} extension(s), #{total_routes} route(s); #{result.skipped.size} skipped")
      end

      # Generate a starter handler.rb at ~/.clacky/api_ext/<name>/handler.rb.
      # Returns the path to the generated file. Mounts at /api/ext/<name>/<name>/...
      def scaffold(name, dir: DEFAULT_DIR)
        slug = name.to_s.strip.downcase.gsub(/[^a-z0-9_-]+/, "-").gsub(/\A-+|-+\z/, "")
        raise ArgumentError, "invalid api_ext name: #{name.inspect}" if slug.empty?

        target_dir = File.join(dir, slug)
        path = File.join(target_dir, "handler.rb")
        raise ArgumentError, "api_ext already exists: #{path}" if File.exist?(path)

        FileUtils.mkdir_p(target_dir)
        File.write(path, skeleton(slug))
        path
      end

      private def skeleton(slug)
        const = slug.split(/[-_]/).map(&:capitalize).join + "Ext"
        <<~RUBY
          # frozen_string_literal: true

          # Custom HTTP API extension mounted at /api/ext/#{slug}/#{slug}/
          # Scaffolded by `clacky api_ext_new #{slug}` — fill in routes (relative
          # to the mount, e.g. `get "/hello"` → /api/ext/#{slug}/#{slug}/hello).
          class #{const} < Clacky::ApiExtension
            get "/hello" do
              json(message: "hello from #{slug}")
            end

            # Examples — uncomment and adapt:
            #
            # post "/items" do
            #   body = json_body
            #   error!("name required", status: 422) unless body["name"]
            #   File.write(data_path("items.json"), body.to_json)
            #   json(ok: true)
            # end
            #
            # get "/items/:id" do
            #   json(id: params[:id])
            # end
          end
        RUBY
      end
    end
  end
end
