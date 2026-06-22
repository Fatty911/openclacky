# frozen_string_literal: true

require "open3"

module Clacky
  module Server
    # Read-mostly git operations scoped to a session's working directory, backing
    # the official "git" WebUI panel. Commands run with explicit argv (no shell),
    # so user-supplied values (paths, messages) cannot inject. Write operations
    # are limited to a guarded `commit`; history-rewriting / remote-mutating
    # commands are never exposed here.
    module GitPanel
      module_function

      # Run a git subcommand in `dir` with argv-style args (no shell). Returns
      # [stdout, stderr, success_bool]. Never raises on git failure.
      def git(dir, *args)
        out, err, status = Open3.capture3("git", "-C", dir.to_s, *args)
        [out, err, status.success?]
      rescue StandardError => e
        ["", e.message, false]
      end

      # Whether `dir` is inside a git work tree.
      def repo?(dir)
        out, _err, ok = git(dir, "rev-parse", "--is-inside-work-tree")
        ok && out.strip == "true"
      end

      # { branch:, ahead:, behind:, files: [{ path:, x:, y:, staged:, untracked: }] }
      # Parsed from `git status --porcelain=v2 --branch`.
      def status(dir)
        out, _err, ok = git(dir, "status", "--porcelain=v2", "--branch")
        return { branch: nil, files: [] } unless ok

        branch = nil
        ahead = behind = 0
        files = []
        out.each_line do |line|
          line = line.chomp
          if line.start_with?("# branch.head ")
            branch = line.sub("# branch.head ", "")
          elsif line.start_with?("# branch.ab ")
            m = line.match(/\+(\d+) -(\d+)/)
            ahead, behind = m[1].to_i, m[2].to_i if m
          elsif line.start_with?("1 ", "2 ")
            xy = line.split(" ")[1]
            path = line.split(" ", 9).last
            files << { path: path, x: xy[0], y: xy[1],
                       staged: xy[0] != ".", untracked: false }
          elsif line.start_with?("? ")
            files << { path: line.sub("? ", ""), x: "?", y: "?",
                       staged: false, untracked: true }
          end
        end
        { branch: branch, ahead: ahead, behind: behind, files: files }
      end

      # Unified diff. `file` (optional, relative) limits to one path; omitted =
      # whole working tree (tracked changes). `--` guards path from being read
      # as an option.
      def diff(dir, file: nil)
        args = ["diff"]
        args += ["--", file] if file && !file.empty?
        out, _err, _ok = git(dir, *args)
        out
      end

      # Recent commits: [{ hash:, short:, author:, date:, subject: }].
      def log(dir, limit: 50)
        limit = limit.to_i.clamp(1, 200)
        fmt = "%H%x1f%h%x1f%an%x1f%ad%x1f%s"
        out, _err, ok = git(dir, "log", "-n", limit.to_s, "--date=short", "--pretty=format:#{fmt}")
        return [] unless ok

        out.each_line.filter_map do |line|
          h, short, author, date, subject = line.chomp.split("\x1f")
          next unless h
          { hash: h, short: short, author: author, date: date, subject: subject }
        end
      end

      # [{ name:, current: bool }] from `git branch`.
      def branches(dir)
        out, _err, ok = git(dir, "branch", "--format=%(refname:short)%00%(HEAD)")
        return [] unless ok

        out.each_line.filter_map do |line|
          name, head = line.chomp.split("\x00")
          next unless name && !name.empty?
          { name: name, current: head == "*" }
        end
      end

      # Stage `files` (relative paths) and commit with `message`. Returns
      # { ok:, error?:, hash? }. Refuses empty message / empty file set. Uses
      # argv so paths/message cannot inject; no --no-verify, no amend.
      def commit(dir, message:, files:)
        msg   = message.to_s.strip
        paths = Array(files).map(&:to_s).reject(&:empty?)
        return { ok: false, error: "commit message is required" } if msg.empty?
        return { ok: false, error: "no files selected" } if paths.empty?

        _out, add_err, add_ok = git(dir, "add", "--", *paths)
        return { ok: false, error: "git add failed: #{add_err.strip}" } unless add_ok

        _out, c_err, c_ok = git(dir, "commit", "-m", msg, "--", *paths)
        return { ok: false, error: "git commit failed: #{c_err.strip}" } unless c_ok

        head, _err, _ok = git(dir, "rev-parse", "--short", "HEAD")
        { ok: true, hash: head.strip }
      end
    end
  end
end
