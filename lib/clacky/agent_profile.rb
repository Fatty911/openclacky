# frozen_string_literal: true

require "yaml"

module Clacky
  # Loads and represents an agent profile (system prompt + skill whitelist).
  #
  # Lookup order for a profile named "coding":
  #   1. ~/.clacky/agents/coding/          (user override, physical dir)
  #   2. <gem>/lib/clacky/default_agents/coding/  (built-in default, physical dir)
  #   3. extension agent unit with id == "coding"  (ext.yml contributes.agents)
  #
  # Each physical profile directory must contain:
  #   - profile.yml       — name, description, skills whitelist
  #   - system_prompt.md  — agent-specific system prompt content
  #
  # Global files (shared across all agents), also with user-override support:
  #   - SOUL.md   — agent personality/values
  #   - USER.md   — user profile information
  #   - base_prompt.md — universal behavioral rules (todo manager, tool usage, etc.)
  class AgentProfile
    DEFAULT_AGENTS_DIR = File.expand_path("../default_agents", __FILE__).freeze
    USER_AGENTS_DIR = File.expand_path("~/.clacky/agents").freeze

    attr_reader :name, :description

    def initialize(name)
      @name = name.to_s
      @ext_unit = ExtensionLoader.last_result&.agents&.find { |u| u.id == @name }
      profile_data = load_profile_yml
      @description = profile_data["description"] || ""
      @system_prompt_content = load_agent_file("system_prompt.md")
    end

    # Load a named profile. Raises ArgumentError if profile directory not found.
    # @param name [String, Symbol] profile name (e.g. "coding", "general")
    # @return [AgentProfile]
    def self.load(name)
      new(name)
    end

    # List all available agent profiles across the three layers.
    # Precedence on id collision: user override → ext unit → built-in default.
    # @return [Array<Hash>] each: { id:, title:, description:, source: }
    def self.all
      out = {}

      add = lambda do |id, title, title_zh, description, description_zh, source, order|
        next if id.nil? || id.empty?
        out[id] ||= {
          id: id,
          title: title,
          title_zh: title_zh,
          description: description,
          description_zh: description_zh,
          source: source,
          order: order,
        }
      end

      ExtensionLoader.last_result&.agents&.each do |unit|
        spec = unit.spec || {}
        title = spec["title"].to_s
        title = unit.id if title.empty?
        add.call(
          unit.id, title, spec["title_zh"].to_s,
          spec["description"].to_s, spec["description_zh"].to_s,
          "extension", spec["order"]
        )
      end

      Dir.glob(File.join(USER_AGENTS_DIR, "*")).sort.each do |path|
        next unless File.directory?(path)
        id = File.basename(path)
        next if id.start_with?("_")
        next unless File.file?(File.join(path, "profile.yml"))
        meta = read_profile_yml(File.join(path, "profile.yml"))
        add.call(
          id, meta["title"] || meta["name"] || id, meta["title_zh"].to_s,
          meta["description"].to_s, meta["description_zh"].to_s,
          "user", meta["order"]
        )
      end

      Dir.glob(File.join(DEFAULT_AGENTS_DIR, "*")).sort.each do |path|
        next unless File.directory?(path)
        id = File.basename(path)
        next if id.start_with?("_")
        next unless File.file?(File.join(path, "profile.yml"))
        meta = read_profile_yml(File.join(path, "profile.yml"))
        add.call(
          id, meta["title"] || meta["name"] || id.capitalize, meta["title_zh"].to_s,
          meta["description"].to_s, meta["description_zh"].to_s,
          "default", meta["order"]
        )
      end

      source_rank = { "default" => 0, "user" => 1, "extension" => 2 }
      out.values.sort_by { |a| [source_rank[a[:source]] || 9, a[:order] || 999, a[:id]] }
    end

    private_class_method def self.read_profile_yml(path)
      return {} unless File.file?(path)
      YAML.safe_load(File.read(path)) || {}
    rescue StandardError
      {}
    end

    # @return [String] agent-specific system prompt content
    def system_prompt
      @system_prompt_content
    end

    # @return [String] base prompt shared by all agents
    def base_prompt
      load_global_file("base_prompt.md")
    end

    # @return [String] soul content (user override → built-in default)
    def soul
      load_global_file("SOUL.md")
    end

    # @return [String] user profile content (user override → built-in default)
    def user_profile
      load_global_file("USER.md")
    end

    private def load_profile_yml
      path = find_agent_file("profile.yml")
      if path
        return YAML.safe_load(File.read(path)) || {}
      end

      if @ext_unit
        return {
          "name"        => @name,
          "description" => @ext_unit.spec["description"],
          "panels"      => @ext_unit.spec["panels"],
          "skills"      => @ext_unit.spec["skills"],
        }
      end

      raise ArgumentError, "Agent profile '#{@name}' not found. " \
        "Looked in #{user_agent_dir} and #{default_agent_dir}"
    end

    # Load a file from the agent-specific directory (user override → ext unit → built-in)
    private def load_agent_file(filename)
      path = find_agent_file(filename)
      return File.read(path).strip if path

      if @ext_unit && filename == "system_prompt.md"
        prompt_abs = @ext_unit.spec["prompt_abs"]
        return File.read(prompt_abs).strip if prompt_abs && File.file?(prompt_abs)
      end

      ""
    end

    # Load a global file shared across all agents (user override → built-in)
    private def load_global_file(filename)
      user_path = File.join(USER_AGENTS_DIR, filename)
      default_path = File.join(DEFAULT_AGENTS_DIR, filename)

      path = if File.exist?(user_path) && !File.zero?(user_path)
               user_path
             elsif File.exist?(default_path)
               default_path
             end

      return "" unless path

      File.read(path).strip
    end

    # Find a file in user override dir first, then built-in default dir
    private def find_agent_file(filename)
      user_path = File.join(user_agent_dir, filename)
      default_path = File.join(default_agent_dir, filename)

      if File.exist?(user_path) && !File.zero?(user_path)
        user_path
      elsif File.exist?(default_path)
        default_path
      end
    end

    private def user_agent_dir
      File.join(USER_AGENTS_DIR, @name)
    end

    private def default_agent_dir
      File.join(DEFAULT_AGENTS_DIR, @name)
    end
  end
end
