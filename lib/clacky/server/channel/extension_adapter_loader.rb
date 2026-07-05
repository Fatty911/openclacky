# frozen_string_literal: true

require_relative "user_adapter_loader"

module Clacky
  module Channel
    module Adapters
      # Loads channel adapters contributed by ext.yml containers via
      # `contributes.channels: [{ id, adapter }]`. Reuses
      # UserAdapterLoader.load_one so the require / register / interface check
      # / error isolation contract stays identical.
      module ExtensionAdapterLoader
        Result = UserAdapterLoader::Result

        def self.load_all
          result = Result.new(loaded: [], skipped: [])
          units = Array(Clacky::ExtensionLoader.last_result&.channels)
          units.each do |unit|
            name = "#{unit.ext_id}/#{unit.id}"
            UserAdapterLoader.load_one(unit.spec["adapter_abs"], name, result)
          end
          @last_result = result
          result
        end

        def self.last_result
          @last_result || load_all
        end
      end
    end
  end
end
