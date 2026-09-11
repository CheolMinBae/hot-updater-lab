#!/usr/bin/env ruby
# The UI test targets the already installed app by its bundle identifier. It
# deliberately has no dependency on the app target, so OTA tests never rebuild
# or replace the baseline native application.
require 'fileutils'
require 'xcodeproj'

output = File.expand_path(ARGV.fetch(0))
FileUtils.mkdir_p(output)
project_path = File.join(output, 'SDKSmoke.xcodeproj')
project = Xcodeproj::Project.new(project_path)
target = project.new_target(:ui_test_bundle, 'SDKSmoke', :ios, '15.1', nil, :swift)
# xcodeproj's fallback SDK reference can name an older device SDK. Resolve the
# system framework from the simulator SDK selected by xcodebuild instead.
target.frameworks_build_phase.files_references.each do |framework|
  framework.path = "System/Library/Frameworks/#{framework.name}"
  framework.source_tree = 'SDKROOT'
end
target.source_build_phase.add_file_reference(
  project.main_group.new_file(File.expand_path('SDKSmokeTests.swift', __dir__))
)
target.build_configurations.each do |configuration|
  configuration.build_settings.merge!(
    'PRODUCT_BUNDLE_IDENTIFIER' => 'net.prostacks.otademo.sdksmoke',
    'PRODUCT_NAME' => '$(TARGET_NAME)',
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'SWIFT_VERSION' => '5.0',
    'TARGETED_DEVICE_FAMILY' => '1,2',
    'CODE_SIGNING_ALLOWED' => 'NO',
    'SUPPORTED_PLATFORMS' => 'iphonesimulator',
    'ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES' => 'YES',
    'LD_RUNPATH_SEARCH_PATHS' => [
      '$(inherited)', '@executable_path/Frameworks', '@loader_path/Frameworks'
    ]
  )
end
project.save

scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(target, false)
scheme.add_test_target(target)
scheme.test_action.build_configuration = 'Release'
scheme.test_action.should_use_launch_scheme_args_env = false
scheme.test_action.environment_variables = Xcodeproj::XCScheme::EnvironmentVariables.new([
  { key: 'EXPECTED_BASELINE_LABEL', value: ENV.fetch('EXPECTED_BASELINE_LABEL', '') },
  { key: 'EXPECTED_OTA_LABEL', value: ENV.fetch('EXPECTED_OTA_LABEL', '') }
])
scheme.save_as(project_path, 'SDKSmoke', true)
puts project_path
