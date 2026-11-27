import ExpoModulesCore
import Foundation

/// `sampleFrame` result: `{ width, height, rgba: Uint8Array }`.
@Record
struct PocketVideoSampleResult {
  var width: Int = 0
  var height: Int = 0
  var rgba: Data = Data()
}

/// JS module `PocketVideo` (PocketVideoNativeModule in src/types.ts) with the views `PocketVideoView`
/// and `PocketScopeView`.
///
/// Functions use the Expo Modules 2.0 macros. Views use the `View(…)` DSL inside `definition()`:
/// expo-modules-core 58 implements `@ExpoView` in the macro plugin but does not declare it (nor
/// `ExpoNativeView`), so the DSL is the supported way to register UIKit views.
@ExpoModule("PocketVideo")
public final class PocketVideoModule: Module {
  @JS(.concurrent)
  func loadLut(id: String, cubeText: String) async throws -> Int {
    do {
      return try PocketVideoLutRegistry.shared.load(id: id, cubeText: cubeText)
    } catch let error as PocketVideoLutError {
      throw Exception(name: "ERR_POCKET_LUT", description: error.description)
    }
  }

  @JS
  func unloadLut(id: String) {
    PocketVideoLutRegistry.shared.unload(id)
  }

  @JS(.concurrent)
  func snapshot(sessionId: String, withEffects: Bool) async throws -> String {
    guard let metal = PocketVideoMetal.shared else {
      throw Exception(name: "ERR_POCKET_VIDEO", description: "Metal is unavailable.")
    }
    guard let session = PocketVideoSessionHub.shared.existing(sessionId), let frame = session.latestFrame() else {
      throw Exception(name: "ERR_POCKET_NO_FRAME", description: "No decoded frame for session \(sessionId).")
    }
    let effects = withEffects ? session.lastEffects : PocketPictureEffects()
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
    let renderer = PocketVideoRenderer(metal: metal)
    guard let rgba = await renderer.renderOffscreen(source: .frame(frame), effects: effects, width: width, height: height, stretch: false),
      let url = PocketVideoRenderer.writeJPEG(rgba: rgba, width: width, height: height)
    else {
      throw Exception(name: "ERR_POCKET_SNAPSHOT", description: "Snapshot render or JPEG encode failed.")
    }
    return url.absoluteString
  }

  @JS(.concurrent)
  func sampleFrame(sessionId: String, width: Int, height: Int) async -> PocketVideoSampleResult? {
    guard let metal = PocketVideoMetal.shared,
      let session = PocketVideoSessionHub.shared.existing(sessionId),
      let frame = session.latestFrame()
    else { return nil }
    let w = max(1, min(width, 1024))
    let h = max(1, min(height, 1024))
    // The camera signal, unprocessed (meters read codes, not the monitoring look).
    let renderer = PocketVideoRenderer(metal: metal)
    guard let rgba = await renderer.renderOffscreen(source: .frame(frame), effects: PocketPictureEffects(), width: w, height: h, stretch: true)
    else { return nil }
    return PocketVideoSampleResult(width: w, height: h, rgba: Data(rgba))
  }

  public func definition() -> ModuleDefinition {
    View(PocketVideoView.self) {
      ViewName("PocketVideoView")
      Events("onFrameStats")
      Prop("sessionId") { (view: PocketVideoView, id: String?) in view.setSessionId(id) }
      Prop("demoScene") { (view: PocketVideoView, scene: String?) in view.setDemoScene(scene) }
      Prop("effects") { (view: PocketVideoView, effects: [String: Any]?) in view.setEffects(effects) }
      Prop("resizeMode") { (view: PocketVideoView, mode: String?) in view.setResizeMode(mode) }
    }

    View(PocketScopeView.self) {
      ViewName("PocketScopeView")
      Prop("sessionId") { (view: PocketScopeView, id: String?) in view.setSessionId(id) }
      Prop("demoScene") { (view: PocketScopeView, scene: String?) in view.setDemoScene(scene) }
      Prop("kind") { (view: PocketScopeView, kind: String?) in view.setKind(kind) }
      Prop("options") { (view: PocketScopeView, options: [String: Any]?) in view.setOptions(options) }
      Prop("brightness") { (view: PocketScopeView, value: Double?) in view.setBrightness(value) }
      Prop("measureAfterLut") { (view: PocketScopeView, value: Bool?) in view.setMeasureAfterLut(value) }
      Prop("effects") { (view: PocketScopeView, effects: [String: Any]?) in view.setEffects(effects) }
    }
  }
}
