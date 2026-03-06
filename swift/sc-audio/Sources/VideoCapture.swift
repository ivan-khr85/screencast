import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreVideo

final class VideoCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "sc-video.capture", qos: .userInteractive)
    private var frameBuffer = Data()

    func start(displayIndex: Int, fps: Int) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: false
        )

        guard content.displays.indices.contains(displayIndex) else {
            throw VideoCaptureError.displayNotFound(displayIndex)
        }

        let display = content.displays[displayIndex]
        let width = display.width
        let height = (display.height / 2) * 2  // Round down to even for NV12 4:2:0 compatibility

        // Pre-allocate NV12 frame buffer: Y plane (w*h) + UV plane (w*h/2)
        frameBuffer = Data(count: width * height * 3 / 2)

        let filter = SCContentFilter(
            display: display,
            excludingApplications: [],
            exceptingWindows: []
        )

        let config = SCStreamConfiguration()
        config.capturesAudio = false
        config.width = width
        config.height = height
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange // NV12
        config.showsCursor = true

        stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream!.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try await stream!.startCapture()

        // Notify Node.js of frame dimensions via stderr before any frame data
        let header = "{\"width\":\(width),\"height\":\(height)}\n"
        FileHandle.standardError.write(Data(header.utf8))
    }

    func stop() {
        Task {
            try? await stream?.stopCapture()
            stream = nil
        }
    }

    // MARK: - SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        guard sampleBuffer.isValid else { return }
        guard let imageBuffer = sampleBuffer.imageBuffer else { return }

        CVPixelBufferLockBaseAddress(imageBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(imageBuffer, .readOnly) }

        guard CVPixelBufferGetPlaneCount(imageBuffer) == 2 else { return }

        let width = CVPixelBufferGetWidth(imageBuffer)
        let height = CVPixelBufferGetHeight(imageBuffer)
        let needed = width * height * 3 / 2

        if frameBuffer.count != needed {
            frameBuffer = Data(count: needed)
        }

        guard let yBase = CVPixelBufferGetBaseAddressOfPlane(imageBuffer, 0) else { return }
        guard let uvBase = CVPixelBufferGetBaseAddressOfPlane(imageBuffer, 1) else { return }
        let yBytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(imageBuffer, 0)
        let uvBytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(imageBuffer, 1)

        frameBuffer.withUnsafeMutableBytes { dst in
            guard let base = dst.baseAddress else { return }
            // Y plane: height rows, each width bytes (strip row padding)
            for row in 0..<height {
                memcpy(base.advanced(by: row * width), yBase.advanced(by: row * yBytesPerRow), width)
            }
            // UV plane: height/2 rows, each width bytes (interleaved U+V, strip padding)
            let uvStart = width * height
            let uvHeight = height / 2
            for row in 0..<uvHeight {
                memcpy(base.advanced(by: uvStart + row * width), uvBase.advanced(by: row * uvBytesPerRow), width)
            }
        }

        do {
            try FileHandle.standardOutput.write(contentsOf: frameBuffer)
        } catch {
            exit(0)
        }
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write(Data("Video stream stopped: \(error.localizedDescription)\n".utf8))
        exit(1)
    }
}

enum VideoCaptureError: LocalizedError {
    case displayNotFound(Int)

    var errorDescription: String? {
        switch self {
        case .displayNotFound(let index): return "Display \(index) not found"
        }
    }
}
