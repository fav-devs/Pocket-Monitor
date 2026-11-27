require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'PocketNative'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platforms      = { :ios => '17.0' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/fav-devs/Pocket-Monitor.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift,metal}'
  s.frameworks = 'CoreBluetooth', 'NetworkExtension', 'Network', 'VideoToolbox', 'Metal', 'MetalKit', 'CoreMedia', 'CoreVideo', 'GameController', 'CoreMotion', 'Vision', 'AVFoundation', 'CoreImage', 'MediaToolbox'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
