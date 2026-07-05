# frozen_string_literal: true

require "spec_helper"

module PatchLoaderSpecFixture
  class Target
    def greet
      "hello"
    end

    def self.shout
      "HEY"
    end
  end

  class ApplyTarget
    def greet
      "hello"
    end
  end
end

RSpec.describe Clacky::PatchLoader do
  let(:tmp) { Dir.mktmpdir }
  let(:empty_ext_result) do
    Clacky::ExtensionLoader::Result.new(
      panels: [], api: [], skills: [], agents: [], channels: [], patches: [], hooks: [],
      errors: [], overridden: [], containers: {}
    )
  end

  before do
    @prev_ext_result = Clacky::ExtensionLoader.instance_variable_get(:@last_result)
    Clacky::ExtensionLoader.instance_variable_set(:@last_result, empty_ext_result)
  end

  after do
    FileUtils.remove_entry(tmp)
    Clacky::ExtensionLoader.instance_variable_set(:@last_result, @prev_ext_result)
  end

  def make_patch(id, meta:, patch_rb:)
    dir = File.join(tmp, id)
    FileUtils.mkdir_p(dir)
    File.write(File.join(dir, "meta.yml"), meta)
    File.write(File.join(dir, "patch.rb"), patch_rb) if patch_rb
    dir
  end

  describe ".fingerprint" do
    it "computes a stable fingerprint for an instance method" do
      fp = described_class.fingerprint("PatchLoaderSpecFixture::Target#greet")
      expect(fp).to match(/\A[0-9a-f]{64}\z/)
      expect(fp).to eq(described_class.fingerprint("PatchLoaderSpecFixture::Target#greet"))
    end

    it "resolves class methods via '.'" do
      expect(described_class.fingerprint("PatchLoaderSpecFixture::Target.shout")).to match(/\A[0-9a-f]{64}\z/)
    end

    it "raises on an unresolvable target" do
      expect { described_class.fingerprint("No::Such::Const#x") }.to raise_error(StandardError)
    end
  end

  describe ".load_all" do
    it "applies a patch whose fingerprint matches" do
      fp = described_class.fingerprint("PatchLoaderSpecFixture::ApplyTarget#greet")
      make_patch("ok",
        meta: "target: \"PatchLoaderSpecFixture::ApplyTarget#greet\"\nfingerprint: \"#{fp}\"\n",
        patch_rb: <<~RUBY)
          module PatchOk
            def greet
              "patched"
            end
          end
          PatchLoaderSpecFixture::ApplyTarget.prepend(PatchOk)
        RUBY

      result = described_class.load_all(dir: tmp)

      expect(result.applied).to include("ok")
      expect(PatchLoaderSpecFixture::ApplyTarget.new.greet).to eq("patched")
    end

    it "disables a patch whose fingerprint no longer matches" do
      make_patch("stale",
        meta: "target: \"PatchLoaderSpecFixture::Target#greet\"\nfingerprint: \"deadbeef\"\non_mismatch: disable\n",
        patch_rb: "module PatchStale; end\n")

      result = described_class.load_all(dir: tmp)

      expect(result.disabled.map(&:first)).to include("stale")
      expect(Dir.exist?(File.join(tmp, "stale"))).to be false
      expect(Dir.exist?(File.join(tmp, "_disabled", "stale"))).to be true
    end

    it "keeps but does not apply a mismatched patch when on_mismatch is warn" do
      make_patch("warned",
        meta: "target: \"PatchLoaderSpecFixture::Target#greet\"\nfingerprint: \"deadbeef\"\non_mismatch: warn\n",
        patch_rb: "module PatchWarned; end\n")

      result = described_class.load_all(dir: tmp)

      expect(result.skipped.map(&:first)).to include("warned")
      expect(Dir.exist?(File.join(tmp, "warned"))).to be true
    end

    it "skips a patch with missing meta fields" do
      make_patch("bad", meta: "description: nothing\n", patch_rb: "")
      result = described_class.load_all(dir: tmp)
      expect(result.skipped.map(&:first)).to include("bad")
    end

    it "ignores patches already in _disabled/" do
      dir = File.join(tmp, "_disabled", "old")
      FileUtils.mkdir_p(dir)
      File.write(File.join(dir, "meta.yml"), "target: \"x#y\"\nfingerprint: \"z\"\n")

      result = described_class.load_all(dir: tmp)
      expect(result.applied).to be_empty
      expect(result.disabled).to be_empty
      expect(result.skipped).to be_empty
    end
  end

  describe ".scaffold" do
    it "generates meta.yml with a computed fingerprint and a patch.rb skeleton" do
      dir = described_class.scaffold("my-fix", "PatchLoaderSpecFixture::Target#greet",
                                     description: "test", dir: tmp)

      meta = YAMLCompat.load_file(File.join(dir, "meta.yml"))
      expect(meta["target"]).to eq("PatchLoaderSpecFixture::Target#greet")
      expect(meta["fingerprint"]).to match(/\A[0-9a-f]{64}\z/)
      expect(meta["on_mismatch"]).to eq("disable")

      patch = File.read(File.join(dir, "patch.rb"))
      expect(patch).to include("def greet")
      expect(patch).to include("PatchLoaderSpecFixture::Target.prepend")
      expect { RubyVM::InstructionSequence.compile(patch) }.not_to raise_error
    end

    it "raises when the patch id already exists" do
      described_class.scaffold("dup", "PatchLoaderSpecFixture::Target#greet", dir: tmp)
      expect { described_class.scaffold("dup", "PatchLoaderSpecFixture::Target#greet", dir: tmp) }
        .to raise_error(ArgumentError, /already exists/)
    end
  end
end
