# frozen_string_literal: true

require "spec_helper"

module ExtPatchSpecFixture
  class WebSearch
    def execute
      "original"
    end
  end
end

RSpec.describe Clacky::PatchLoader, "with extension-contributed patches" do
  let(:builtin)   { Dir.mktmpdir }
  let(:installed) { Dir.mktmpdir }
  let(:local)     { Dir.mktmpdir }
  let(:patches_dir) { Dir.mktmpdir }

  after do
    [builtin, installed, local, patches_dir].each { |d| FileUtils.remove_entry(d) if Dir.exist?(d) }
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

  it "applies a trusted ext patch (no fingerprint)" do
    manifest = <<~YAML
      id: timeout-pack
      origin: self
      contributes:
        patches:
          - target: "ExtPatchSpecFixture::WebSearch#execute"
            file: patches/timeout.rb
    YAML
    patch_body = <<~RUBY
      module ExtPatchTimeout
        def execute
          "patched"
        end
      end
      ExtPatchSpecFixture::WebSearch.prepend(ExtPatchTimeout)
    RUBY
    make_ext(local, "timeout-pack", manifest, "patches/timeout.rb" => patch_body)

    reload_layers
    result = described_class.load_all(dir: patches_dir)

    expect(result.applied).to include("timeout-pack/timeout")
    expect(ExtPatchSpecFixture::WebSearch.new.execute).to eq("patched")
  end

  it "skips an ext patch when its declared fingerprint mismatches the current source" do
    manifest = <<~YAML
      id: stale-pack
      origin: self
      contributes:
        patches:
          - target: "ExtPatchSpecFixture::WebSearch#execute"
            file: patches/stale.rb
            fingerprint: "deadbeef"
            on_mismatch: warn
    YAML
    make_ext(local, "stale-pack", manifest, "patches/stale.rb" => "module Unused; end\n")

    reload_layers
    result = described_class.load_all(dir: patches_dir)

    expect(result.applied).not_to include("stale-pack/stale")
    expect(result.skipped.map(&:first)).to include("stale-pack/stale")
  end

  it "is a no-op when no ext patches are contributed" do
    reload_layers
    result = described_class.load_all(dir: patches_dir)
    expect(result.applied).to be_empty
  end
end
