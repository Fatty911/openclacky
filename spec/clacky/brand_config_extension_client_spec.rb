# frozen_string_literal: true

require "spec_helper"

# Tests for the extension marketplace client methods on BrandConfig:
#   #upload_extension! / #fetch_my_extensions! / #delete_extension!
# All use the same license-HMAC signed-request scheme as the skill client API.

RSpec.describe Clacky::BrandConfig, "extension marketplace client" do
  EXT_TEST_KEY = "0000002A-00000007-DEADBEEF-CAFEBABE-A1B2C3D4"

  def licensed_config
    described_class.new(
      "brand_name"      => "X",
      "license_key"     => EXT_TEST_KEY,
      "license_user_id" => "42"
    )
  end

  let(:fake_client) { instance_double(Clacky::PlatformHttpClient) }

  before do
    allow_any_instance_of(described_class).to receive(:platform_client).and_return(fake_client)
  end

  describe "#upload_extension!" do
    it "refuses when not user-licensed" do
      config = described_class.new("brand_name" => "X", "license_key" => EXT_TEST_KEY)
      result = config.upload_extension!("my-ext", "zipdata")
      expect(result[:success]).to be false
      expect(result[:error]).to match(/User license required/)
    end

    it "POSTs a multipart body and returns the extension on success" do
      config = licensed_config

      expect(fake_client).to receive(:multipart_post) do |path, body, boundary, **|
        expect(path).to eq("/api/v1/client/extensions")
        expect(body).to include(boundary)
        expect(body).to include('name="extension_zip"; filename="my-ext.zip"')
        expect(body).to include('name="signature"')
        { success: true, data: { "extension" => { "name" => "my-ext", "status" => "published" } } }
      end

      result = config.upload_extension!("my-ext", "zipdata", status: "published")
      expect(result[:success]).to be true
      expect(result[:extension]["name"]).to eq("my-ext")
    end

    it "uses PATCH when force is true" do
      config = licensed_config

      expect(fake_client).to receive(:multipart_patch)
        .with("/api/v1/client/extensions/my-ext", kind_of(String), kind_of(String), read_timeout: 60)
        .and_return({ success: true, data: { "extension" => { "name" => "my-ext" } } })

      result = config.upload_extension!("my-ext", "zipdata", force: true)
      expect(result[:success]).to be true
    end

    it "flags already_exists on a name-taken conflict" do
      config = licensed_config

      allow(fake_client).to receive(:multipart_post)
        .and_return({ success: false, error: "HTTP 409", data: { "code" => "name_taken" } })

      result = config.upload_extension!("my-ext", "zipdata")
      expect(result[:success]).to be false
      expect(result[:already_exists]).to be true
    end
  end

  describe "#fetch_my_extensions!" do
    it "GETs a signed query and returns the extensions list" do
      config = licensed_config

      expect(fake_client).to receive(:get) do |path|
        expect(path).to start_with("/api/v1/client/extensions?")
        expect(path).to include("signature=")
        { success: true, data: { "extensions" => [{ "name" => "my-ext" }] } }
      end

      result = config.fetch_my_extensions!
      expect(result[:success]).to be true
      expect(result[:extensions].first["name"]).to eq("my-ext")
    end

    it "returns error when not user-licensed" do
      config = described_class.new("brand_name" => "X", "license_key" => EXT_TEST_KEY)
      result = config.fetch_my_extensions!
      expect(result[:success]).to be false
      expect(result[:extensions]).to eq([])
    end
  end

  describe "#delete_extension!" do
    it "DELETEs a signed path and returns success" do
      config = licensed_config

      expect(fake_client).to receive(:delete) do |path|
        expect(path).to start_with("/api/v1/client/extensions/my-ext?")
        expect(path).to include("signature=")
        { success: true, data: {} }
      end

      result = config.delete_extension!("my-ext")
      expect(result[:success]).to be true
    end

    it "propagates a failure error" do
      config = licensed_config
      allow(fake_client).to receive(:delete)
        .and_return({ success: false, error: "extension_not_found", data: {} })

      result = config.delete_extension!("nope")
      expect(result[:success]).to be false
      expect(result[:error]).to eq("extension_not_found")
    end
  end
end
