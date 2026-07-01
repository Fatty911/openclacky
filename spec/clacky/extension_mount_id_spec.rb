# frozen_string_literal: true

require "spec_helper"

RSpec.describe Clacky::Extension::MountId do
  it "round-trips through to_s / parse" do
    mid = described_class.new("hello", "dashboard")
    expect(mid.to_s).to eq("hello/dashboard")
    parsed = described_class.parse(mid.to_s)
    expect(parsed).to eq(mid)
  end

  it "is usable directly wherever a String is expected (via to_str)" do
    mid = described_class.new("a", "b")
    expect("prefix-" + mid).to eq("prefix-a/b")
  end

  it "is comparable and hash-safe (works as a Hash key)" do
    a = described_class.new("x", "y")
    b = described_class.new("x", "y")
    map = { a => 1 }
    expect(map[b]).to eq(1)
  end

  it "returns nil for garbage input" do
    expect(described_class.parse(nil)).to be_nil
    expect(described_class.parse("")).to be_nil
    expect(described_class.parse("no-slash")).to be_nil
    expect(described_class.parse("/leading")).to be_nil
    expect(described_class.parse("trailing/")).to be_nil
  end

  it "keeps trailing path segments intact — only splits on the first slash" do
    mid = described_class.parse("ext/unit/with/extra")
    expect(mid.ext_id).to eq("ext")
    expect(mid.unit_id).to eq("unit/with/extra")
  end
end
