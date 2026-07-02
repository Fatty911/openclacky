# frozen_string_literal: true

require "spec_helper"
require "clacky/server/http_server"
require "clacky/agent_config"

RSpec.describe Clacky::Server::HttpServer, "extension panel scope" do
  let(:builtin)   { Dir.mktmpdir }
  let(:installed) { Dir.mktmpdir }
  let(:local)     { Dir.mktmpdir }

  let(:server) do
    described_class.new(
      host:           "127.0.0.1",
      port:           0,
      agent_config:   instance_double(Clacky::AgentConfig),
      client_factory: -> { double("client") },
      sessions_dir:   Dir.mktmpdir
    )
  end

  after do
    [builtin, installed, local].each { |d| FileUtils.remove_entry(d) if Dir.exist?(d) }
    Clacky::ExtensionLoader.instance_variable_set(:@last_result, nil)
  end

  def make_ext(root, ext_id, manifest, files = {})
    dir = File.join(root, ext_id)
    FileUtils.mkdir_p(dir)
    File.write(File.join(dir, "ext.yml"), manifest)
    files.each do |rel, content|
      path = File.join(dir, rel)
      FileUtils.mkdir_p(File.dirname(path))
      File.write(path, content)
    end
  end

  def reload_layers
    Clacky::ExtensionLoader.load_all(
      layers: { builtin: builtin, installed: installed, local: local }
    )
  end

  def stub_agent_profiles(map)
    allow(server).to receive(:agent_profile_data).and_return(map)
  end

  it "intersects panel→agents with scope: agent:<name>" do
    manifest = <<~YAML
      id: canvas-pack
      origin: self
      contributes:
        panels:
          - id: canvas
            view: panels/canvas/view.js
            scope: agent:designer
    YAML
    make_ext(local, "canvas-pack", manifest, "panels/canvas/view.js" => "")

    reload_layers
    stub_agent_profiles(
      "designer" => { "panels" => ["canvas"] },
      "coding"   => { "panels" => ["canvas"] }
    )

    expect(server.send(:panel_agents_map)["canvas"]).to eq(["designer"])
  end

  it "leaves a scope: global panel's references untouched" do
    manifest = <<~YAML
      id: git-pack
      origin: self
      contributes:
        panels:
          - id: git
            view: panels/git/view.js
            scope: global
    YAML
    make_ext(local, "git-pack", manifest, "panels/git/view.js" => "")

    reload_layers
    stub_agent_profiles(
      "designer" => { "panels" => ["git"] },
      "coding"   => { "panels" => ["git"] }
    )

    expect(server.send(:panel_agents_map)["git"]).to contain_exactly("designer", "coding")
  end

  it "yields an empty referencing list when no agent points at a scoped panel" do
    manifest = <<~YAML
      id: canvas-pack
      origin: self
      contributes:
        panels:
          - id: canvas
            view: panels/canvas/view.js
            scope: agent:designer
    YAML
    make_ext(local, "canvas-pack", manifest, "panels/canvas/view.js" => "")

    reload_layers
    stub_agent_profiles("coding" => { "panels" => ["git"] })

    expect(server.send(:panel_agents_map)["canvas"]).to eq([])
  end

  it "gives a scope: global panel visibility to every known agent even when no profile references it" do
    manifest = <<~YAML
      id: meeting-pack
      origin: self
      contributes:
        panels:
          - id: meeting
            view: panels/meeting/view.js
            scope: global
    YAML
    make_ext(local, "meeting-pack", manifest, "panels/meeting/view.js" => "")

    reload_layers
    stub_agent_profiles(
      "general" => {},
      "coding"  => { "panels" => ["git"] }
    )

    expect(server.send(:panel_agents_map)["meeting"]).to contain_exactly("general", "coding")
  end
end
