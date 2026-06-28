# frozen_string_literal: true

require_relative "ui_interface"

module Clacky
  # A UI controller that swallows every event. Used for detached/background
  # subagents whose intermediate output must never reach a real UI stream
  # (e.g. the WebUI chat transcript). All UIInterface methods are inherited
  # as no-ops, so nothing this agent emits is broadcast anywhere.
  class NullUIController
    include Clacky::UIInterface
  end
end
