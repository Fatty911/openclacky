# frozen_string_literal: true

require "erb"
require "fileutils"
require "ostruct"

module Clacky
  module ExtensionScaffold
    # Copy a template directory into `target`, rendering `.erb` files with
    # ERB and substituting `__key__` placeholders in path segments. Non-erb
    # files are copied byte-for-byte.
    #
    # Placeholders in filenames use the `__slug__` form (double underscores
    # around the key) — any locals key can be referenced this way.
    class TemplateRenderer
      PATH_PLACEHOLDER = /__([a-z_][a-z0-9_]*)__/.freeze

      def self.render(template_dir:, target:, locals: {})
        new(template_dir, target, locals).render
      end

      def initialize(template_dir, target, locals)
        @template_dir = File.expand_path(template_dir)
        @target       = target
        @locals       = locals
        @binding      = OpenStruct.new(locals).instance_eval { binding }
      end

      def render
        raise ArgumentError, "template dir not found: #{@template_dir}" unless Dir.exist?(@template_dir)

        Dir.glob(File.join(@template_dir, "**", "{*,.[!.]*}"), File::FNM_DOTMATCH).sort.each do |src|
          next if [".", ".."].include?(File.basename(src))

          rel  = src.sub(/\A#{Regexp.escape(@template_dir)}\/?/, "")
          next if rel.empty?

          dest = File.join(@target, substitute_path(rel))

          if File.directory?(src)
            FileUtils.mkdir_p(dest)
          elsif File.extname(src) == ".erb"
            FileUtils.mkdir_p(File.dirname(dest))
            File.write(dest.sub(/\.erb\z/, ""), ERB.new(File.read(src), trim_mode: "-").result(@binding))
          else
            FileUtils.mkdir_p(File.dirname(dest))
            FileUtils.cp(src, dest)
          end
        end

        @target
      end

      private def substitute_path(rel)
        rel.gsub(PATH_PLACEHOLDER) do
          key = Regexp.last_match(1).to_sym
          raise ArgumentError, "unknown path placeholder: __#{key}__" unless @locals.key?(key)

          @locals[key].to_s
        end
      end
    end
  end
end
