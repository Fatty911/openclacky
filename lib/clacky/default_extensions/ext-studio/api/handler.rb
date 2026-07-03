# frozen_string_literal: true

require "json"
require "tmpdir"

# Extension Studio — backend for the debug/publish panels. Mounted at
# /api/ext/ext-studio/. Reads the resolved extension tree, runs the verifier,
# packs and publishes local containers to the marketplace.
class ExtStudioExt < Clacky::ApiExtension
  timeout 60

  # GET /api/ext/ext-studio/extensions
  # List every local-layer container with a units summary and verify status,
  # so the debug panel can populate its picker and detail view.
  get "/extensions" do
    result = Clacky::ExtensionLoader.load_all(force: true)
    issues = Clacky::ExtensionVerifier.verify(result)

    exts = local_containers(result).map do |ext_id, container|
      serialize_container(ext_id, container, result, issues)
    end
    exts.sort_by! { |e| -e[:mtime] }

    json(extensions: exts)
  end

  # POST /api/ext/ext-studio/verify
  # body: { ext_id? }  — omit ext_id to verify the whole tree.
  # Returns structured issues (same shape the CLI prints) plus resolved units.
  post "/verify" do
    ext_id = json_body["ext_id"].to_s.strip
    result = Clacky::ExtensionLoader.load_all(force: true)
    issues = Clacky::ExtensionVerifier.verify(result)

    scoped = ext_id.empty? ? issues : issues.select { |i| i.ext == ext_id }
    units  = result.units
    units  = units.select { |u| u.ext_id == ext_id } unless ext_id.empty?

    json(
      ext_id: ext_id.empty? ? nil : ext_id,
      units: units.map { |u| serialize_unit(u) },
      issues: scoped.map { |i| serialize_issue(i) },
      ok: scoped.none? { |i| i.level == :error }
    )
  end

  # POST /api/ext/ext-studio/pack
  # body: { ext_id }
  # Packs a local container into a zip (into a temp dir) and reports its path.
  post "/pack" do
    ext_id = require_ext_id!
    Dir.mktmpdir("clacky-ext-studio-pack") do |tmp|
      res = Clacky::ExtensionPackager.pack(ext_id, out_dir: tmp)
      json(ok: true, ext_id: res.ext_id, path: res.path)
    end
  rescue Clacky::ExtensionPackager::Error => e
    error!(e.message, status: 422)
  end

  # POST /api/ext/ext-studio/publish
  # body: { ext_id, force?, status?, changelog? }
  # Packs then uploads to the marketplace. Requires an activated user license.
  post "/publish" do
    ext_id = require_ext_id!
    brand = Clacky::BrandConfig.load
    unless brand.activated? && brand.user_licensed?
      error!("publishing requires an activated user license", status: 403)
    end

    Dir.mktmpdir("clacky-ext-studio-publish") do |tmp|
      res      = Clacky::ExtensionPackager.pack(ext_id, out_dir: tmp)
      zip_data = File.binread(res.path)

      result = brand.upload_extension!(
        res.ext_id, zip_data,
        force:     json_body["force"] == true,
        status:    presence(json_body["status"]),
        changelog: presence(json_body["changelog"])
      )

      if result[:success]
        ext = result[:extension] || {}
        ver = (ext["latest_version"] || {})["version"]
        json(ok: true, ext_id: res.ext_id, version: ver, status: ext["status"])
      elsif result[:already_exists]
        json(ok: false, already_exists: true,
             error: "#{res.ext_id} already published. Publish a new version with force.")
      else
        error!(result[:error] || "publish failed", status: 502)
      end
    end
  rescue Clacky::ExtensionPackager::Error => e
    error!(e.message, status: 422)
  end

  # GET /api/ext/ext-studio/published
  # List the current user's published extensions from the marketplace.
  get "/published" do
    brand  = Clacky::BrandConfig.load
    result = brand.fetch_my_extensions!
    error!(result[:error] || "failed to fetch published extensions", status: 502) unless result[:success]

    exts = Array(result[:extensions]).map do |ext|
      {
        id: ext["id"] || ext["slug"] || ext["name"],
        name: ext["name"],
        version: (ext["latest_version"] || {})["version"] || ext["version"],
        status: ext["status"],
        units: ext["units"] || {}
      }
    end
    json(extensions: exts)
  end

  # POST /api/ext/ext-studio/unpublish
  # body: { ext_id }
  post "/unpublish" do
    ext_id = require_ext_id!
    result = Clacky::BrandConfig.load.delete_extension!(ext_id)
    error!(result[:error] || "unpublish failed", status: 502) unless result[:success]
    json(ok: true, ext_id: ext_id)
  end

  # POST /api/ext/ext-studio/develop
  # body: { idea? }
  # Spawns a session bound to the ext-developer agent, optionally seeded with
  # the user's idea as the first task — the "let AI build it for me" entry.
  post "/develop" do
    idea = presence(json_body["idea"])
    name = idea ? "扩展开发: #{idea[0, 40]}" : "扩展开发"
    sid  = create_session(name: name, prompt: idea, profile: "ext-developer", source: :setup)
    json(ok: true, session_id: sid)
  end

  private def local_containers(result)
    Array(result.containers).select { |_id, c| c[:layer] == :local }
  end

  private def serialize_container(ext_id, container, result, issues)
    raw = container[:raw] || {}
    ext_issues = issues.select { |i| i.ext == ext_id }
    dir = container[:dir]
    {
      id: ext_id,
      name: raw["name"] || ext_id,
      description: raw["description"],
      version: raw["version"],
      origin: container[:origin],
      layer: container[:layer].to_s,
      dir: dir,
      mtime: File.mtime(File.join(dir, "ext.yml")).to_i,
      units: result.units.select { |u| u.ext_id == ext_id }.map { |u| serialize_unit(u) },
      error_count: ext_issues.count { |i| i.level == :error },
      warning_count: ext_issues.count { |i| i.level == :warning }
    }
  end

  private def serialize_unit(unit)
    { kind: unit.kind.to_s, id: unit.id, layer: unit.layer.to_s }
  end

  private def serialize_issue(issue)
    {
      ext: issue.ext,
      unit: issue.unit,
      level: issue.level.to_s,
      code: issue.code,
      message: issue.message,
      file: issue.file,
      hint: issue.hint
    }
  end

  private def require_ext_id!
    id = json_body["ext_id"].to_s.strip
    error!("ext_id required", status: 422) if id.empty?
    id
  end

  private def presence(value)
    str = value.to_s.strip
    str.empty? ? nil : str
  end
end
