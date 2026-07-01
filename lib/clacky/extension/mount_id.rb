# frozen_string_literal: true

module Clacky
  module Extension
    # A registry key used everywhere an api unit's identity is expressed:
    # ApiExtension.registry, ApiExtensionLoader loading path, log lines,
    # dispatcher path routing. Formatted as "<ext_id>/<unit_id>" — this class
    # is the single source of truth for that format so no code hand-splits or
    # hand-joins the string.
    class MountId
      attr_reader :ext_id, :unit_id

      def initialize(ext_id, unit_id)
        @ext_id  = ext_id.to_s
        @unit_id = unit_id.to_s
      end

      def self.parse(str)
        return nil unless str.is_a?(String)

        ext_id, unit_id = str.split("/", 2)
        return nil if ext_id.nil? || ext_id.empty? || unit_id.nil? || unit_id.empty?

        new(ext_id, unit_id)
      end

      def to_s
        "#{@ext_id}/#{@unit_id}"
      end
      alias to_str to_s

      def ==(other)
        other.is_a?(MountId) && other.ext_id == ext_id && other.unit_id == unit_id
      end
      alias eql? ==

      def hash
        [ext_id, unit_id].hash
      end
    end
  end
end
