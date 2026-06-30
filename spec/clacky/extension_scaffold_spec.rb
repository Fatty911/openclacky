# frozen_string_literal: true

require "spec_helper"

RSpec.describe Clacky::ExtensionScaffold do
  let(:dir) { Dir.mktmpdir }
  after { FileUtils.remove_entry(dir) if Dir.exist?(dir) }

  describe ".new_container" do
    it "generates a container that the loader resolves with no errors" do
      path = described_class.new_container("hello-panel", dir: dir)

      expect(File).to exist(File.join(path, "ext.yml"))
      expect(File).to exist(File.join(path, "panels/hello/view.js"))
      expect(File).to exist(File.join(path, "panels/hello/handler.rb"))

      result = Clacky::ExtensionLoader.load_all(layers: { local: dir })
      expect(result.errors).to be_empty
      expect(result.panels.size).to eq(1)
      expect(result.api.size).to eq(1)
    end

    it "slugifies the id" do
      path = described_class.new_container("My Cool Ext!", dir: dir)
      expect(File.basename(path)).to eq("my-cool-ext")
    end

    it "generates a handler that defines an ApiExtension subclass with a route" do
      path = described_class.new_container("ping", dir: dir)
      handler = File.read(File.join(path, "panels/hello/handler.rb"))
      expect(handler).to match(/class PingExt < Clacky::ApiExtension/)
      expect(handler).to match(%r{get "/hello"})
    end

    it "refuses to overwrite an existing container" do
      described_class.new_container("dup", dir: dir)
      expect { described_class.new_container("dup", dir: dir) }
        .to raise_error(ArgumentError, /already exists/)
    end

    it "rejects an id that slugifies to empty" do
      expect { described_class.new_container("!!!", dir: dir) }
        .to raise_error(ArgumentError, /invalid extension id/)
    end
  end

  describe ".pack_webui" do
    let(:webui) { Dir.mktmpdir }
    after { FileUtils.remove_entry(webui) if Dir.exist?(webui) }

    it "moves a loose webui js into a panel container and removes the source" do
      src = File.join(webui, "badge.js")
      File.write(src, "// badge")

      path = described_class.pack_webui("badge", webui_ext_dir: webui, dir: dir)

      expect(File).to exist(File.join(path, "panels/badge/view.js"))
      expect(File).not_to exist(src)

      result = Clacky::ExtensionLoader.load_all(layers: { local: dir })
      expect(result.errors).to be_empty
      expect(result.panels.first.ext_id).to eq("badge")
    end

    it "raises when the source file is missing" do
      expect { described_class.pack_webui("nope", webui_ext_dir: webui, dir: dir) }
        .to raise_error(ArgumentError, /no webui extension/)
    end
  end

  describe ".pack_api" do
    let(:api_ext) { Dir.mktmpdir }
    after { FileUtils.remove_entry(api_ext) if Dir.exist?(api_ext) }

    it "moves a loose api handler into an api container and removes the source" do
      src = File.join(api_ext, "metrics")
      FileUtils.mkdir_p(src)
      File.write(File.join(src, "handler.rb"), "# handler")

      path = described_class.pack_api("metrics", api_ext_dir: api_ext, dir: dir)

      expect(File).to exist(File.join(path, "api/metrics/handler.rb"))
      expect(Dir).not_to exist(src)
    end

    it "refuses to pack a protected extension" do
      src = File.join(api_ext, "brand")
      FileUtils.mkdir_p(src)
      File.write(File.join(src, "handler.rb"), "# handler")
      File.write(File.join(src, "meta.yml"), "protected: true\n")

      expect { described_class.pack_api("brand", api_ext_dir: api_ext, dir: dir) }
        .to raise_error(ArgumentError, /protected/)
    end
  end
end
