# frozen_string_literal: true

require "spec_helper"

RSpec.describe Clacky::ExtensionLoader do
  let(:builtin)   { Dir.mktmpdir }
  let(:installed) { Dir.mktmpdir }
  let(:local)     { Dir.mktmpdir }

  let(:layers) { { builtin: builtin, installed: installed, local: local } }

  after do
    [builtin, installed, local].each { |d| FileUtils.remove_entry(d) if Dir.exist?(d) }
  end

  def make_container(root, id, manifest:, files: {})
    dir = File.join(root, id)
    FileUtils.mkdir_p(dir)
    File.write(File.join(dir, "ext.yml"), manifest)
    files.each do |rel, content|
      path = File.join(dir, rel)
      FileUtils.mkdir_p(File.dirname(path))
      File.write(path, content)
    end
    dir
  end

  describe ".load_all" do
    it "resolves a panel unit with an inline api backend" do
      manifest = <<~YAML
        id: hello
        origin: self
        contributes:
          panels:
            - id: hello
              view: panels/hello/view.js
              api: panels/hello/handler.rb
              scope: global
      YAML
      make_container(local, "hello", manifest: manifest, files: {
        "panels/hello/view.js"    => "// view",
        "panels/hello/handler.rb" => "# handler",
      })

      result = described_class.load_all(layers: layers)

      expect(result.errors).to be_empty
      expect(result.panels.size).to eq(1)
      expect(result.api.size).to eq(1)

      panel = result.panels.first
      expect(panel.ext_id).to eq("hello")
      expect(panel.spec["scope"]).to eq("global")

      api = result.api.first
      expect(api.ext_id).to eq("hello")
      expect(api.spec["handler_abs"]).to end_with("panels/hello/handler.rb")
    end

    it "lets a higher layer override the same id and records the override" do
      manifest = <<~YAML
        id: dup
        origin: self
        contributes:
          panels:
            - id: p
              view: view.js
              scope: global
      YAML

      make_container(builtin, "dup", manifest: manifest, files: { "view.js" => "// builtin" })
      make_container(local, "dup", manifest: manifest, files: { "view.js" => "// local" })

      result = described_class.load_all(layers: layers)

      expect(result.panels.size).to eq(1)
      expect(result.panels.first.layer).to eq(:local)
      expect(result.overridden).to eq([["dup", :builtin, :local]])
    end

    it "records a structured error when a panel view file is missing" do
      make_container(local, "broken", manifest: <<~YAML)
        id: broken
        origin: self
        contributes:
          panels:
            - id: p
              view: panels/missing.js
              scope: global
      YAML

      result = described_class.load_all(layers: layers)

      expect(result.panels).to be_empty
      expect(result.errors.size).to eq(1)
      expect(result.errors.first.ext_id).to eq("broken")
      expect(result.errors.first.message).to match(/view file not found/)
    end

    it "rejects an invalid origin" do
      make_container(local, "bad-origin", manifest: <<~YAML, files: { "view.js" => "" })
        id: bad-origin
        origin: pirate
        contributes:
          panels:
            - id: p
              view: view.js
      YAML

      result = described_class.load_all(layers: layers)

      expect(result.units).to be_empty
      expect(result.errors.first.message).to match(/invalid origin/)
    end

    it "rejects an invalid scope" do
      make_container(local, "bad-scope", manifest: <<~YAML, files: { "view.js" => "" })
        id: bad-scope
        origin: self
        contributes:
          panels:
            - id: p
              view: view.js
              scope: everyone
      YAML

      result = described_class.load_all(layers: layers)

      expect(result.panels).to be_empty
      expect(result.errors.first.message).to match(/invalid scope/)
    end

    it "accepts an agent-scoped panel" do
      make_container(local, "scoped", manifest: <<~YAML, files: { "view.js" => "" })
        id: scoped
        origin: self
        contributes:
          panels:
            - id: p
              view: view.js
              scope: agent:designer
      YAML

      result = described_class.load_all(layers: layers)

      expect(result.errors).to be_empty
      expect(result.panels.first.spec["scope"]).to eq("agent:designer")
    end

    it "isolates a malformed ext.yml without aborting other containers" do
      make_container(local, "good", manifest: <<~YAML, files: { "view.js" => "" })
        id: good
        origin: self
        contributes:
          panels:
            - id: p
              view: view.js
      YAML
      make_container(local, "junk", manifest: "just a string")

      result = described_class.load_all(layers: layers)

      expect(result.panels.map(&:ext_id)).to eq(["good"])
      expect(result.errors.map(&:ext_id)).to include("junk")
    end

    it "returns empty when no containers exist" do
      result = described_class.load_all(layers: layers)
      expect(result.units).to be_empty
      expect(result.errors).to be_empty
    end
  end
end
