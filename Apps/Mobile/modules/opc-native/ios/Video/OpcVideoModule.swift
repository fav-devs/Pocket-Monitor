import ExpoModulesCore
import Foundation

/// `sampleFrame` result: `{ width, height, rgba: Uint8Array }`.
@Record
struct OpcVideoSampleResult {
  var width: Int = 0
  var height: Int = 0
  var rgba: Data = Data()
}

/// JS module `OpcVideo` (OpcVideoNativeModule in src/types.ts) with the views `OpcVideoView`
/// and `OpcScopeView`.
///
/// Functions use the Expo Modules 2.0 macros. Views use the `View(…)` DSL inside `definition()`:
/// expo-modules-core 58 implements `@ExpoView` in the macro plugin but does not declare it (nor
/// `ExpoNativeView`), so the DSL is the supported way to register UIKit views.
@ExpoModule("OpcVideo")
public final class OpcVideoModule: Module {
  @JS(.concurrent)
  func loadLut(id: String, cubeText: String) async throws -> Int {
    do {
      return try OpcVideoLutRegistry.shared.load(id: id, cubeText: cubeText)
    } catch let error as OpcVideoLutError {
      throw Exception(name: "ERR_OPC_LUT", description: error.description)
    }
  }

  @JS
  func unloadLut(id: String) {
    OpcVideoLutRegistry.shared.unload(id)
  }

  @JS(.concurrent)
  func snapshot(sessionId: String, withEffects: Bool) async throws -> String {
    guard let metal = OpcVideoMetal.shared else {
      throw Exception(name: "ERR_OPC_VIDEO", description: "Metal is unavailable.")
    }
    guard let session = OpcVideoSessionHub.shared.existing(sessionId), let frame = session.latestFrame() else {
      throw Exception(name: "ERR_OPC_NO_FRAME", description: "No decoded frame for session \(sessionId).")
    }
    let effects = withEffects ? session.lastEffects : OpcPictureEffects()
    var width = frame.width
    var height = frame.height
    if withEffects, abs(effects.desqueeze - 1) > 0.001 {
      if effects.desqueezeVertical {
        height = Int((Double(height) * Double(effects.desqueeze)).rounded())
      } else {
        width = Int((Double(width) * Double(effects.desqueeze)).rounded())
      }
    }
    let scale = min(1, 4096 / Double(max(width, height)))
    width = max(1, Int(Double(width) * scale))
    height = max(1, Int(Double(height) * scale))
    let renderer = OpcVideoRenderer(metal: metal)
    guard let rgba = await renderer.renderOffscreen(source: .frame(frame), effects: effects, width: width, height: height, stretch: false),
      let url = OpcVideoRenderer.writeJPEG(rgba: rgba, width: width, height: height)
    else {
      throw Exception(name: "ERR_OPC_SNAPSHOT", description: "Snapshot render or JPEG encode failed.")
    }
    return url.absoluteString
  }

  @JS(.concurrent)
  func sampleFrame(sessionId: String, width: Int, height: Int) async -> OpcVideoSampleResult? {
    guard let metal = OpcVideoMetal.shared,
      let session = OpcVideoSessionHub.shared.existing(sessionId),
      let frame = session.latestFrame()
    else { return nil }
    let w = max(1, min(width, 1024))
    let h = max(1, min(height, 1024))
    // The camera signal, unprocessed (meters read codes, not the monitoring look).
    let renderer = OpcVideoRenderer(metal: metal)
    guard let rgba = await renderer.renderOffscreen(source: .frame(frame), effects: OpcPictureEffects(), width: w, height: h, stretch: true)
    else { return nil }
    return OpcVideoSampleResult(width: w, height: h, rgba: Data(rgba))
  }

  public func definition() -> ModuleDefinition {
    View(OpcVideoView.self) {
      ViewName("OpcVideoView")
      Events("onFrameStats")
      Prop("sessionId") { (view: OpcVideoView, id: String?) in view.setSessionId(id) }
      Prop("demoScene") { (view: OpcVideoView, scene: String?) in view.setDemoScene(scene) }
      Prop("effects") { (view: OpcVideoView, effects: [String: Any]?) in view.setEffects(effects) }
      Prop("resizeMode") { (view: OpcVideoView, mode: String?) in view.setResizeMode(mode) }
    }

    View(OpcScopeView.self) {
      ViewName("OpcScopeView")
      Prop("sessionId") { (view: OpcScopeView, id: String?) in view.setSessionId(id) }
      Prop("demoScene") { (view: OpcScopeView, scene: String?) in view.setDemoScene(scene) }
      Prop("kind") { (view: OpcScopeView, kind: String?) in view.setKind(kind) }
      Prop("options") { (view: OpcScopeView, options: [String: Any]?) in view.setOptions(options) }
      Prop("brightness") { (view: OpcScopeView, value: Double?) in view.setBrightness(value) }
      Prop("measureAfterLut") { (view: OpcScopeView, value: Bool?) in view.setMeasureAfterLut(value) }
      Prop("effects") { (view: OpcScopeView, effects: [String: Any]?) in view.setEffects(effects) }
    }
  }
}
