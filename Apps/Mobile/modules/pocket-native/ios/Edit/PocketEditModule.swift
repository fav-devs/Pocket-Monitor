import AVFoundation
import ExpoModulesCore
import Foundation

/// JS module `PocketEdit` (`PocketEditNativeModule` in src/edit.ts): the playback editor's
/// native colour stage on the expo-video player, the clip exporter and a frame grabber.
///
/// Classic Module DSL (like expo-video): it takes expo-video's `VideoPlayer` as a `SharedObject`
/// argument — expo-video's player is a `SharedRef<AVPlayer>` — which the v2 macros do not cover.
public final class PocketEditModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PocketEdit")

    Events("onExportProgress")

    Function("setLut") { (key: String, size: Int, rgb: Float32Array) in
      guard size >= 2, size <= 65 else {
        throw Exception(name: "ERR_POCKET_EDIT_LUT", description: "Unsupported cube size \(size).")
      }
      let count = size * size * size * 3
      guard rgb.length >= count else {
        throw Exception(name: "ERR_POCKET_EDIT_LUT", description: "The cube has \(rgb.length) values, expected \(count).")
      }
      // Copied here, on the JS thread, while the typed array is alive.
      let pointer = rgb.rawPointer.assumingMemoryBound(to: Float.self)
      PocketEditLutRegistry.shared.set(key, size: size, rgb: UnsafeBufferPointer(start: pointer, count: count))
    }

    Function("dropLut") { (key: String) in
      PocketEditLutRegistry.shared.drop(key)
    }

    Function("attachPreview") { (player: SharedObject, plan: [String: Any]) in
      guard let ref = player as? SharedRef<AVPlayer> else {
        throw Exception(name: "ERR_POCKET_EDIT_PLAYER", description: "Not an expo-video player.")
      }
      let avPlayer = ref.ref
      let parsed = PocketEditPreviewPlan(plan)
      DispatchQueue.main.async {
        MainActor.assumeIsolated { PocketEditPreview.shared.attach(avPlayer, plan: parsed) }
      }
    }

    Function("detachPreview") { (player: SharedObject) in
      guard let ref = player as? SharedRef<AVPlayer> else { return }
      let avPlayer = ref.ref
      DispatchQueue.main.async {
        MainActor.assumeIsolated { PocketEditPreview.shared.detach(avPlayer) }
      }
    }

    AsyncFunction("grabFrame") { (uri: String, seconds: Double, maxWidth: Int) async throws -> [String: Any]? in
      guard let frame = try await PocketEditFrameGrabber.grab(uri: uri, seconds: seconds, maxWidth: maxWidth) else { return nil }
      return ["width": frame.width, "height": frame.height, "rgba": frame.rgba]
    }

    AsyncFunction("startExport") { (jobId: String, plan: [String: Any]) async throws -> String in
      let parsed: PocketEditExportPlan
      do {
        parsed = try PocketEditExportPlan(plan)
      } catch let error as PocketEditError {
        throw Exception(name: "ERR_POCKET_EDIT_EXPORT", description: error.description)
      }
      do {
        let url = try await PocketEditExporter.shared.run(jobId, plan: parsed) { [weak self] fraction in
          self?.sendEvent("onExportProgress", ["jobId": jobId, "fraction": fraction])
        }
        return url.absoluteString
      } catch let error as PocketEditError {
        throw Exception(name: "ERR_POCKET_EDIT_EXPORT", description: error.description)
      }
    }

    Function("cancelExport") { (jobId: String) in
      PocketEditExporter.shared.cancel(jobId)
    }
  }
}
