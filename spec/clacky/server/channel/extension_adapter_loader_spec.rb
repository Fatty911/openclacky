# frozen_string_literal: true

require "spec_helper"
require "clacky/server/channel"

RSpec.describe Clacky::Channel::Adapters::ExtensionAdapterLoader do
  let(:builtin)   { Dir.mktmpdir }
  let(:installed) { Dir.mktmpdir }
  let(:local)     { Dir.mktmpdir }

  after do
    [builtin, installed, local].each { |d| FileUtils.remove_entry(d) if Dir.exist?(d) }
    Clacky::ExtensionLoader.instance_variable_set(:@last_result, nil)
    [:ext_demo, :ext_broken].each { |p| Clacky::Channel::Adapters.unregister(p) }
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

  def adapter_body(platform, klass_name)
    <<~RUBY
      module Clacky
        module Channel
          module Adapters
            class #{klass_name} < Base
              def self.platform_id; :#{platform}; end
              def self.platform_config(data); {}; end
              def initialize(config); @config = config; end
              def start(&blk); end
              def stop; end
              def send_text(chat_id, text, reply_to: nil); { message_id: "1" }; end
              Adapters.register(platform_id, self)
            end
          end
        end
      end
    RUBY
  end

  it "loads and registers an ext-contributed channel adapter" do
    manifest = <<~YAML
      id: demo-pack
      origin: self
      contributes:
        channels:
          - id: ext_demo
            adapter: channels/demo.rb
    YAML
    make_ext(local, "demo-pack", manifest, "channels/demo.rb" => adapter_body("ext_demo", "ExtDemoAdapter"))

    reload_layers
    result = described_class.load_all

    expect(result.loaded).to include("demo-pack/ext_demo")
    expect(result.skipped).to be_empty
    expect(Clacky::Channel::Adapters.find(:ext_demo)).not_to be_nil
  end

  it "isolates a broken adapter and reports it under skipped" do
    body = <<~RUBY
      module Clacky
        module Channel
          module Adapters
            class ExtBrokenAdapter < Base
              def self.platform_id; :ext_broken; end
              def self.platform_config(data); {}; end
              # missing: start, stop, send_text
              Adapters.register(platform_id, self)
            end
          end
        end
      end
    RUBY
    manifest = <<~YAML
      id: broken-pack
      origin: self
      contributes:
        channels:
          - id: ext_broken
            adapter: channels/broken.rb
    YAML
    make_ext(local, "broken-pack", manifest, "channels/broken.rb" => body)

    reload_layers
    result = described_class.load_all

    expect(result.loaded).to be_empty
    expect(result.skipped.first[0]).to eq("broken-pack/ext_broken")
    expect(Clacky::Channel::Adapters.find(:ext_broken)).to be_nil
  end

  it "is a no-op when no ext channels are contributed" do
    reload_layers
    result = described_class.load_all
    expect(result.loaded).to be_empty
    expect(result.skipped).to be_empty
  end
end
