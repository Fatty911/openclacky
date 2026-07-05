# frozen_string_literal: true

require "spec_helper"

# Tests for the extension marketplace client methods on BrandConfig:
#   #upload_extension! / #fetch_my_extensions! / #delete_extension!
# All authenticate with the device token stored in identity.yml.

RSpec.describe Clacky::BrandConfig, "extension marketplace client" do
  let(:fake_client) { instance_double(Clacky::PlatformHttpClient) }
  let(:bound_identity)   { Clacky::Identity.new("device_token" => "clacky-dt-abc", "user_id" => 42) }
  let(:unbound_identity) { Clacky::Identity.new({}) }

  before do
    allow_any_instance_of(described_class).to receive(:platform_client).and_return(fake_client)
    allow(Clacky::Identity).to receive(:load).and_return(bound_identity)
  end

  let(:config) { described_class.new("brand_name" => "X") }

  describe "#upload_extension!" do
    it "refuses when the device is not bound" do
      allow(Clacky::Identity).to receive(:load).and_return(unbound_identity)
      result = config.upload_extension!("my-ext", "zipdata")
      expect(result[:success]).to be false
      expect(result[:error]).to match(/not bound/i)
    end

    it "POSTs a multipart body with the device token and returns the extension on success" do
      expect(fake_client).to receive(:multipart_post) do |path, body, boundary, **|
        expect(path).to eq("/api/v1/client/extensions")
        expect(body).to include(boundary)
        expect(body).to include('name="extension_zip"; filename="my-ext.zip"')
        expect(body).to include('name="device_token"')
        expect(body).to include("clacky-dt-abc")
        { success: true, data: { "extension" => { "name" => "my-ext", "status" => "published" } } }
      end

      result = config.upload_extension!("my-ext", "zipdata", status: "published")
      expect(result[:success]).to be true
      expect(result[:extension]["name"]).to eq("my-ext")
    end

    it "uses PATCH when force is true" do
      expect(fake_client).to receive(:multipart_patch)
        .with("/api/v1/client/extensions/my-ext", kind_of(String), kind_of(String), read_timeout: 60)
        .and_return({ success: true, data: { "extension" => { "name" => "my-ext" } } })

      result = config.upload_extension!("my-ext", "zipdata", force: true)
      expect(result[:success]).to be true
    end

    it "flags already_exists on a name-taken conflict" do
      allow(fake_client).to receive(:multipart_post)
        .and_return({ success: false, error: "HTTP 409", data: { "code" => "name_taken" } })

      result = config.upload_extension!("my-ext", "zipdata")
      expect(result[:success]).to be false
      expect(result[:already_exists]).to be true
    end
  end

  describe "#fetch_my_extensions!" do
    it "GETs with a bearer device token and returns the extensions list" do
      expect(fake_client).to receive(:get) do |path, headers:|
        expect(path).to eq("/api/v1/client/extensions")
        expect(headers["Authorization"]).to eq("Bearer clacky-dt-abc")
        { success: true, data: { "extensions" => [{ "name" => "my-ext" }] } }
      end

      result = config.fetch_my_extensions!
      expect(result[:success]).to be true
      expect(result[:extensions].first["name"]).to eq("my-ext")
    end

    it "returns error when the device is not bound" do
      allow(Clacky::Identity).to receive(:load).and_return(unbound_identity)
      result = config.fetch_my_extensions!
      expect(result[:success]).to be false
      expect(result[:extensions]).to eq([])
    end
  end

  describe "#delete_extension!" do
    it "DELETEs with a bearer device token and returns success" do
      expect(fake_client).to receive(:delete) do |path, headers:|
        expect(path).to eq("/api/v1/client/extensions/my-ext")
        expect(headers["Authorization"]).to eq("Bearer clacky-dt-abc")
        { success: true, data: {} }
      end

      result = config.delete_extension!("my-ext")
      expect(result[:success]).to be true
    end

    it "propagates a failure error" do
      allow(fake_client).to receive(:delete)
        .and_return({ success: false, error: "extension_not_found", data: {} })

      result = config.delete_extension!("nope")
      expect(result[:success]).to be false
      expect(result[:error]).to eq("extension_not_found")
    end
  end
end
