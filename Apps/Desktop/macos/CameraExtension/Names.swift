import CoreVideo
import Foundation

/// The names the viewfinder's facade looks for (`DesktopVirtualCameraABI.swift`). Any
/// change to `device` or `sinkStream` changes it there.
///
/// TODO(rename, docs/desktop-expo-port.md §5.11): `device` and `sinkStream` should become
/// "Pocket Monitor" and "Pocket Monitor Sink" together with `VirtualCameraNames.device` and
/// `.sink` in `Sources/OpenPocketCineDesktopFacade/DesktopVirtualCameraABI.swift`, built
/// and checked on a Mac (the facade finds the camera by these names).
enum CameraNames {
    static let device = "OpenPocketCine"
    static let sourceStream = "Pocket Monitor"
    static let sinkStream = "OpenPocketCine Sink"
    static let model = "Pocket Monitor Virtual Camera"
    static let manufacturer = "Pocket Monitor"

    /// Fixed so apps remember the camera between launches.
    static let deviceID = UUID(uuidString: "5A1D7E9B-3C40-4F3B-9C2E-6F0B4C1E8D7A")!
    static let sourceStreamID = UUID(uuidString: "5A1D7E9B-3C40-4F3B-9C2E-6F0B4C1E8D7B")!
    static let sinkStreamID = UUID(uuidString: "5A1D7E9B-3C40-4F3B-9C2E-6F0B4C1E8D7C")!
}

/// What the picture is: 1280 × 720 NV12 (video range), 30 frames a second, as the
/// viewfinder sends it.
enum CameraFormat {
    static let width: Int32 = 1280
    static let height: Int32 = 720
    static let frameRate: Int32 = 30
    static let pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
}
