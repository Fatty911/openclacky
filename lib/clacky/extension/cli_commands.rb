# frozen_string_literal: true

require "thor"

module Clacky
  # `clacky ext <subcommand>` — manage extension containers (ext.yml).
  #
  # Containers contribute panels (WebUI) and api (HTTP backends). This command
  # group scaffolds, verifies, lists and hot-reloads them.
  class CliExtensionCommands < Thor
    def self.exit_on_failure?
      true
    end

    desc "new ID", "Scaffold a runnable hello-panel container at ~/.clacky/ext/local/ID/"
    method_option :full, type: :boolean, default: false,
                  desc: "Generate a kitchen-sink container exercising all 7 contributes types"
    def new(id)
      path = Clacky::ExtensionScaffold.new_container(id, full: options[:full])
      puts "Created extension container: #{path}"
      if options[:full]
        puts "It contributes panels/api/skills/agents/channels/patches/hooks. Read its README.md, run `clacky ext verify`, then reload the WebUI."
      else
        puts "Reload the WebUI page to see the panel. Edits to view.js and handler.rb take effect on the next request — no restart needed."
      end
    rescue ArgumentError => e
      warn "Error: #{e.message}"
      exit 1
    end

    desc "verify", "Resolve all containers across layers and report units + structured issues"
    def verify
      result = Clacky::ExtensionLoader.load_all

      if result.units.empty? && result.errors.empty?
        puts "No extension containers found."
        return
      end

      result.units.each do |u|
        case u.kind
        when :panel
          puts "[OK]   #{u.ext_id}/#{u.id} (panel, scope=#{u.spec['scope']}, #{u.layer})"
        when :api
          puts "[OK]   #{u.ext_id} (api → /api/ext/#{u.ext_id}/, #{u.layer})"
        else
          puts "[OK]   #{u.ext_id}/#{u.id} (#{u.kind}, #{u.layer})"
        end
      end

      issues = Clacky::ExtensionVerifier.verify(result)
      issues.each do |issue|
        tag = issue.level == :error ? "[ERR]" : "[WARN]"
        unit = issue.unit ? " #{issue.unit}" : ""
        loc  = issue.file ? " [#{issue.file}]" : ""
        hint = issue.hint ? "\n         hint: #{issue.hint}" : ""
        puts "#{tag} #{issue.ext}#{unit} (#{issue.code}) — #{issue.message}#{loc}#{hint}"
      end

      exit 1 if issues.any? { |i| i.level == :error }
    end

    desc "list", "List resolved containers and their contributed units"
    def list
      result = Clacky::ExtensionLoader.load_all

      if result.units.empty?
        puts "No extension units resolved."
        return
      end

      grouped = result.units.group_by(&:ext_id)
      grouped.each do |ext_id, units|
        layer = units.first.layer
        origin = units.first.origin
        puts "#{ext_id} (#{layer}, origin=#{origin})"
        units.each do |u|
          case u.kind
          when :panel
            puts "  panel  #{u.id}  scope=#{u.spec['scope']}"
          when :api
            puts "  api    → /api/ext/#{ext_id}/"
          else
            puts "  #{u.kind.to_s.ljust(6)} #{u.id}"
          end
        end
      end

      result.errors.each do |e|
        puts "[ERR] #{e.ext_id} #{e.unit} — #{e.message}"
      end
    end

  end
end
