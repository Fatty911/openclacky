# frozen_string_literal: true

require "spec_helper"

RSpec.describe Clacky::CliExtensionCommands do
  def run(*args)
    described_class.start(args)
  end

  describe "publish" do
    it "aborts when the device is not bound to a platform account" do
      allow(Clacky::Identity).to receive(:load).and_return(Clacky::Identity.new({}))

      expect { run("publish", "my-ext") }.to raise_error(SystemExit)
        .and output(/not bound to a platform account/).to_stderr
    end

    it "packs then uploads, printing the published version on success" do
      allow(Clacky::Identity).to receive(:load)
        .and_return(Clacky::Identity.new("device_token" => "clacky-dt-abc"))
      brand = instance_double(Clacky::BrandConfig)
      allow(Clacky::BrandConfig).to receive(:load).and_return(brand)

      pack_result = Clacky::ExtensionPackager::Result.new(ext_id: "my-ext", path: nil, units: nil)
      allow(Clacky::ExtensionPackager).to receive(:pack) do |_id, out_dir:|
        path = File.join(out_dir, "my-ext.zip")
        File.binwrite(path, "zipbytes")
        Clacky::ExtensionPackager::Result.new(ext_id: "my-ext", path: path, units: nil)
      end

      expect(brand).to receive(:upload_extension!)
        .with("my-ext", "zipbytes", force: false, status: nil, changelog: nil)
        .and_return({ success: true, extension: { "status" => "published", "latest_version" => { "version" => "1.0.0" } } })

      expect { run("publish", "my-ext") }.to output(/Published my-ext v1.0.0.*status=published/).to_stdout
    end

    it "hints at --force when the extension already exists" do
      allow(Clacky::Identity).to receive(:load)
        .and_return(Clacky::Identity.new("device_token" => "clacky-dt-abc"))
      brand = instance_double(Clacky::BrandConfig)
      allow(Clacky::BrandConfig).to receive(:load).and_return(brand)
      allow(Clacky::ExtensionPackager).to receive(:pack) do |_id, out_dir:|
        path = File.join(out_dir, "my-ext.zip")
        File.binwrite(path, "zipbytes")
        Clacky::ExtensionPackager::Result.new(ext_id: "my-ext", path: path, units: nil)
      end
      allow(brand).to receive(:upload_extension!)
        .and_return({ success: false, already_exists: true, error: "taken" })

      expect { run("publish", "my-ext") }.to raise_error(SystemExit)
        .and output(/--force/).to_stderr
    end
  end

  describe "published" do
    it "lists the creator's extensions" do
      brand = instance_double(Clacky::BrandConfig)
      allow(Clacky::BrandConfig).to receive(:load).and_return(brand)
      allow(brand).to receive(:fetch_my_extensions!).and_return({
        success: true,
        extensions: [
          { "name" => "my-ext", "status" => "published", "units" => { "panels" => 1 },
            "latest_version" => { "version" => "1.2.0" } }
        ]
      })

      expect { run("published") }.to output(/my-ext  v1.2.0  \[published\].*1 panels/).to_stdout
    end

    it "prints an empty-state message when there are none" do
      brand = instance_double(Clacky::BrandConfig)
      allow(Clacky::BrandConfig).to receive(:load).and_return(brand)
      allow(brand).to receive(:fetch_my_extensions!).and_return({ success: true, extensions: [] })

      expect { run("published") }.to output(/not published any extensions/).to_stdout
    end
  end

  describe "unpublish" do
    it "removes an extension and confirms" do
      brand = instance_double(Clacky::BrandConfig)
      allow(Clacky::BrandConfig).to receive(:load).and_return(brand)
      expect(brand).to receive(:delete_extension!).with("my-ext").and_return({ success: true })

      expect { run("unpublish", "my-ext") }.to output(/Unpublished my-ext/).to_stdout
    end
  end
end
