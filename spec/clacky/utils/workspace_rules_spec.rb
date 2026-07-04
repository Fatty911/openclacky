# frozen_string_literal: true

require "tmpdir"

RSpec.describe Clacky::Utils::WorkspaceRules do
  describe ".find_main" do
    it "loads AGENTS.md as project rules" do
      Dir.mktmpdir do |dir|
        File.write(File.join(dir, "AGENTS.md"), "Follow the agent rules.\n")

        result = described_class.find_main(dir)

        expect(result).to include(
          path: File.join(dir, "AGENTS.md"),
          name: "AGENTS.md",
          content: "Follow the agent rules."
        )
      end
    end

    it "keeps .clackyrules ahead of AGENTS.md" do
      Dir.mktmpdir do |dir|
        File.write(File.join(dir, ".clackyrules"), "Use OpenClacky rules.\n")
        File.write(File.join(dir, "AGENTS.md"), "Use agent rules.\n")

        result = described_class.find_main(dir)

        expect(result[:name]).to eq(".clackyrules")
        expect(result[:content]).to eq("Use OpenClacky rules.")
      end
    end

    it "loads AGENTS.md before .cursorrules" do
      Dir.mktmpdir do |dir|
        File.write(File.join(dir, "AGENTS.md"), "Use agent rules.\n")
        File.write(File.join(dir, ".cursorrules"), "Use cursor rules.\n")

        result = described_class.find_main(dir)

        expect(result[:name]).to eq("AGENTS.md")
        expect(result[:content]).to eq("Use agent rules.")
      end
    end

    it "skips an empty AGENTS.md and falls back to CLAUDE.md" do
      Dir.mktmpdir do |dir|
        File.write(File.join(dir, "AGENTS.md"), "\n")
        File.write(File.join(dir, "CLAUDE.md"), "Use Claude rules.\n")

        result = described_class.find_main(dir)

        expect(result[:name]).to eq("CLAUDE.md")
        expect(result[:content]).to eq("Use Claude rules.")
      end
    end
  end
end
