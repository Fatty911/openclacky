# frozen_string_literal: true

module Clacky
  module Media
    # Resolves the on-disk root for generated media files (images, videos,
    # audio) according to a fixed precedence:
    #
    #   1. `param`      — explicit `output_dir` from the API caller.
    #                     Highest priority; lets a single call land
    #                     somewhere specific (e.g. a doc's project root).
    #   2. `configured` — user setting from AgentConfig#media_output_dir.
    #                     Set via Settings → Models → Media Output Directory.
    #   3. `fallback`   — process default; preserves legacy behavior for
    #                     configs that have neither key set.
    #
    # Pure function on purpose: callers (HTTP handlers) read the configured
    # value off AgentConfig and inject it here. Keeps this helper trivially
    # unit-testable and free of global state.
    #
    # The final on-disk path is `<resolved>/assets/generated/<file>` —
    # the `assets/generated/` suffix is appended by Media::Base#save_*
    # for stable relative-path semantics across markdown / slide outputs,
    # and is intentionally not configurable here.
    module OutputDir
      # @param param [String, nil]      explicit per-call override
      # @param configured [String, nil] user-configured default
      # @param fallback [String]        last-resort default (defaults to Dir.pwd)
      # @return [String]                absolute or `~`-prefixed path; the
      #   caller's File.join with "assets/generated/" handles `~` via the
      #   surrounding FileUtils.mkdir_p call only when expanded — for safety
      #   we expand `~` here so downstream sees an absolute path.
      def self.resolve(param:, configured:, fallback: Dir.pwd)
        chosen = first_present(param, configured) || fallback
        File.expand_path(chosen.to_s)
      end

      # @api private
      def self.first_present(*candidates)
        candidates.find { |c| c.is_a?(String) && !c.strip.empty? }
      end
    end
  end
end
