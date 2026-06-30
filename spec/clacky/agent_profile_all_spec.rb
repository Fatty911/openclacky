# frozen_string_literal: true

require "spec_helper"

RSpec.describe Clacky::AgentProfile, ".all" do
  let(:user_dir)    { Dir.mktmpdir }
  let(:default_dir) { Dir.mktmpdir }
  let(:ext_local)   { Dir.mktmpdir }

  before do
    stub_const("Clacky::AgentProfile::USER_AGENTS_DIR", user_dir)
    stub_const("Clacky::AgentProfile::DEFAULT_AGENTS_DIR", default_dir)
    Clacky::ExtensionLoader.load_all(layers: { local: ext_local })
  end

  after do
    [user_dir, default_dir, ext_local].each { |d| FileUtils.remove_entry(d) if Dir.exist?(d) }
    Clacky::ExtensionLoader.instance_variable_set(:@last_result, nil)
  end

  def make_default(id, title:, description: "")
    path = File.join(default_dir, id)
    FileUtils.mkdir_p(path)
    File.write(File.join(path, "profile.yml"), { "title" => title, "description" => description }.to_yaml)
    File.write(File.join(path, "system_prompt.md"), "default prompt")
  end

  def make_user(id, title:, description: "")
    path = File.join(user_dir, id)
    FileUtils.mkdir_p(path)
    File.write(File.join(path, "profile.yml"), { "title" => title, "description" => description }.to_yaml)
    File.write(File.join(path, "system_prompt.md"), "user prompt")
  end

  def make_ext_agent(ext_id, agent_id, title:, description: "")
    dir = File.join(ext_local, ext_id)
    FileUtils.mkdir_p(File.join(dir, "prompts"))
    File.write(File.join(dir, "ext.yml"), <<~YAML)
      id: #{ext_id}
      origin: self
      contributes:
        agents:
          - id: #{agent_id}
            title: #{title}
            description: #{description}
            prompt: prompts/p.md
    YAML
    File.write(File.join(dir, "prompts", "p.md"), "ext prompt")
    Clacky::ExtensionLoader.load_all(layers: { local: ext_local })
  end

  it "lists built-in defaults" do
    make_default("coding", title: "Coding")
    make_default("general", title: "General")

    ids = described_class.all.map { |a| a[:id] }
    expect(ids).to contain_exactly("coding", "general")
    expect(described_class.all.first[:source]).to eq("default")
  end

  it "merges in extension-contributed agents" do
    make_default("coding", title: "Coding")
    make_ext_agent("designer-pack", "designer", title: "Designer", description: "design things")

    all = described_class.all
    designer = all.find { |a| a[:id] == "designer" }

    expect(designer).to include(id: "designer", title: "Designer", source: "extension")
    expect(designer[:description]).to eq("design things")
  end

  it "user override beats both ext and default for the same id" do
    make_default("coding", title: "Coding (default)")
    make_user("coding", title: "Coding (user)", description: "my override")
    make_ext_agent("override-pack", "coding", title: "Coding (ext)")

    coding = described_class.all.find { |a| a[:id] == "coding" }
    expect(coding[:source]).to eq("user")
    expect(coding[:title]).to eq("Coding (user)")
  end

  it "ext beats default when there is no user dir for that id" do
    make_default("designer", title: "Designer (default)")
    make_ext_agent("designer-pack", "designer", title: "Designer (ext)")

    designer = described_class.all.find { |a| a[:id] == "designer" }
    expect(designer[:source]).to eq("extension")
  end
end
