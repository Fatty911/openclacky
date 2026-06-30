# frozen_string_literal: true

require "fileutils"

module Clacky
  # Discovers extension containers across three source layers and resolves them
  # into a flat list of capability units (panels, api) for the rest of the
  # system to mount.
  #
  # A container is a directory holding an `ext.yml` manifest:
  #
  #   id: canvas-suite
  #   name: Canvas Suite
  #   origin: self                 # self | marketplace | enterprise
  #   contributes:
  #     panels:
  #       - id: canvas
  #         view: panels/canvas/view.js
  #         api:  panels/canvas/handler.rb   # optional backend for this panel
  #         scope: agent:designer            # global (default) | agent:<name>
  #     api:
  #       - id: metrics
  #         handler: api/metrics/handler.rb
  #
  # Source layers (ascending priority — same id, higher layer wins):
  #   builtin    gem default_extensions/<id>/
  #   installed  ~/.clacky/ext/installed/<id>/
  #   local      ~/.clacky/ext/local/<id>/
  #
  # `ext.yml` is intentionally distinct from the `meta.yml` files consumed by
  # PatchLoader / ApiExtensionLoader — those are per-unit and have unrelated
  # schemas. This loader never touches them.
  #
  # This class only *discovers and resolves*; actual mounting is done by the
  # existing call sites:
  #   - api units   → ApiExtensionLoader.load_one(...)  (server boot / reload)
  #   - panel units → http_server ext_script_block(...) (rendered per request)
  #
  # Backward compatibility — brand_skills as a degenerate protected container:
  # A `~/.clacky/brand_skills/<name>/` entry is conceptually a vendor container
  # contributing a single protected `skill` unit. That `skill` contributes type
  # is not part of this first step (which wires only `panels` and `api`), so this
  # loader deliberately does NOT scan brand_skills yet. Their encrypt/license/
  # heartbeat chain stays entirely in SkillLoader#load_brand_skills and
  # BrandConfig, unchanged. When the `skill` contributes type lands, brand_skills
  # will be claimed here as `origin: enterprise` + protected units for listing
  # only — never taking over decryption or license gating.
  module ExtensionLoader
    BUILTIN_DIR   = File.expand_path("../default_extensions", __dir__)
    INSTALLED_DIR = File.expand_path("~/.clacky/ext/installed")
    LOCAL_DIR     = File.expand_path("~/.clacky/ext/local")
    MANIFEST      = "ext.yml"

    # Layers in ascending priority; later entries override earlier ones by id.
    LAYERS = %i[builtin installed local].freeze
    ORIGINS = %w[self marketplace enterprise].freeze

    # One resolved capability unit. `kind` is :panel or :api.
    Unit = Struct.new(
      :kind, :id, :ext_id, :layer, :origin, :dir, :spec,
      keyword_init: true
    )

    # One resolution error, structured so an AI author can locate and fix it.
    Error = Struct.new(:ext_id, :layer, :unit, :message, :file, keyword_init: true)

    Result = Struct.new(:panels, :api, :errors, :overridden, keyword_init: true) do
      def units
        panels + api
      end
    end

    class << self
      def dir_for(layer)
        case layer
        when :builtin   then BUILTIN_DIR
        when :installed then INSTALLED_DIR
        when :local     then LOCAL_DIR
        end
      end

      # Scan all layers, resolve overrides, return a structured Result.
      # `layers` maps layer name => root dir; defaults to the real three-layer
      # dirs. Tests inject temp dirs through it.
      def load_all(layers: default_layers)
        by_id = {}          # ext_id => resolved container (winning layer)
        overridden = []     # [ext_id, losing_layer, winning_layer]
        errors = []

        layers.each do |layer, root|
          next unless root && Dir.exist?(root)

          Dir.children(root).sort.each do |ext_id|
            next if ext_id.start_with?("_", ".")
            dir = File.join(root, ext_id)
            next unless File.directory?(dir)

            manifest = File.join(dir, MANIFEST)
            next unless File.file?(manifest)

            container = read_container(ext_id, layer, dir, manifest, errors)
            next unless container

            if (prev = by_id[ext_id])
              overridden << [ext_id, prev[:layer], layer]
            end
            by_id[ext_id] = container
          end
        end

        result = Result.new(panels: [], api: [], errors: errors, overridden: overridden)
        by_id.each_value { |container| resolve_units(container, result) }

        @last_result = result
        result
      end

      def default_layers
        LAYERS.each_with_object({}) { |layer, h| h[layer] = dir_for(layer) }
      end

      def last_result
        @last_result || load_all
      end

      private def read_container(ext_id, layer, dir, manifest, errors)
        data = YAMLCompat.load_file(manifest) || {}
        unless data.is_a?(Hash)
          errors << Error.new(ext_id: ext_id, layer: layer.to_s,
                              message: "ext.yml must be a mapping", file: manifest)
          return nil
        end

        origin = (data["origin"] || "self").to_s
        unless ORIGINS.include?(origin)
          errors << Error.new(ext_id: ext_id, layer: layer.to_s,
                              message: "invalid origin #{origin.inspect} (expected one of #{ORIGINS.join('/')})",
                              file: manifest)
          return nil
        end

        { ext_id: ext_id, layer: layer, dir: dir, origin: origin,
          contributes: data["contributes"] || {} }
      rescue StandardError => e
        errors << Error.new(ext_id: ext_id, layer: layer.to_s,
                            message: "failed to parse ext.yml: #{e.message}", file: manifest)
        nil
      end

      private def resolve_units(container, result)
        contributes = container[:contributes]
        return unless contributes.is_a?(Hash)

        Array(contributes["panels"]).each do |spec|
          unit = build_panel_unit(container, spec, result.errors)
          next unless unit

          result.panels << unit
          # A panel may declare its own backend; load it as an api unit keyed
          # by the panel id so the panel's fetch() calls resolve at runtime.
          if spec["api"]
            api_unit = build_api_unit(container, { "id" => spec["id"], "handler" => spec["api"] }, result.errors)
            result.api << api_unit if api_unit
          end
        end

        Array(contributes["api"]).each do |spec|
          unit = build_api_unit(container, spec, result.errors)
          result.api << unit if unit
        end
      end

      private def build_panel_unit(container, spec, errors)
        ext_id = container[:ext_id]
        unless spec.is_a?(Hash) && spec["id"] && spec["view"]
          errors << Error.new(ext_id: ext_id, layer: container[:layer].to_s, unit: "panel",
                              message: "panel needs both `id` and `view`")
          return nil
        end

        view_abs = File.join(container[:dir], spec["view"])
        unless File.file?(view_abs)
          errors << Error.new(ext_id: ext_id, layer: container[:layer].to_s, unit: "panel/#{spec['id']}",
                              message: "view file not found: #{spec['view']}", file: view_abs)
          return nil
        end

        scope = (spec["scope"] || "global").to_s
        unless scope == "global" || scope.start_with?("agent:")
          errors << Error.new(ext_id: ext_id, layer: container[:layer].to_s, unit: "panel/#{spec['id']}",
                              message: "invalid scope #{scope.inspect} (expected `global` or `agent:<name>`)")
          return nil
        end

        Unit.new(kind: :panel, id: spec["id"].to_s, ext_id: ext_id,
                 layer: container[:layer], origin: container[:origin],
                 dir: container[:dir],
                 spec: { "view" => spec["view"], "api" => spec["api"], "scope" => scope })
      end

      private def build_api_unit(container, spec, errors)
        ext_id = container[:ext_id]
        unless spec.is_a?(Hash) && spec["id"] && spec["handler"]
          errors << Error.new(ext_id: ext_id, layer: container[:layer].to_s, unit: "api",
                              message: "api needs both `id` and `handler`")
          return nil
        end

        handler_abs = File.join(container[:dir], spec["handler"])
        unless File.file?(handler_abs)
          errors << Error.new(ext_id: ext_id, layer: container[:layer].to_s, unit: "api/#{spec['id']}",
                              message: "handler file not found: #{spec['handler']}", file: handler_abs)
          return nil
        end

        Unit.new(kind: :api, id: spec["id"].to_s, ext_id: ext_id,
                 layer: container[:layer], origin: container[:origin],
                 dir: container[:dir],
                 spec: { "handler" => spec["handler"], "handler_abs" => handler_abs })
      end
    end
  end
end
