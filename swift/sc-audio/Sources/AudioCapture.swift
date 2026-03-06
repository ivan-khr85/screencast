import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia

final class AudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var outputHandle: FileHandle
    private let sampleRate: Int
    private let channels: Int

    init(outputHandle: FileHandle, sampleRate: Int = 48000, channels: Int = 2) {
        self.outputHandle = outputHandle
        self.sampleRate = sampleRate
        self.channels = channels
        super.init()
    }

    func start(appBundleID: String? = nil) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: false
        )

        guard let display = content.displays.first else {
            throw CaptureError.noDisplay
        }

        let filter: SCContentFilter
        if let bundleID = appBundleID {
            guard let app = content.applications.first(where: {
                $0.bundleIdentifier == bundleID
            }) else {
                throw CaptureError.appNotFound(bundleID)
            }
            filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
        } else {
            filter = SCContentFilter(
                display: display,
                excludingApplications: [],
                exceptingWindows: []
            )
        }

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = sampleRate
        config.channelCount = channels
        config.width = 64
        config.height = 64
        config.minimumFrameInterval = CMTime(value: 1, timescale: 2)

        stream = SCStream(filter: filter, configuration: config, delegate: self)

        let audioQueue = DispatchQueue(label: "sc-audio.audio", qos: .userInteractive)
        let screenQueue = DispatchQueue(label: "sc-audio.screen", qos: .utility)
        try stream!.addStreamOutput(self, type: .screen, sampleHandlerQueue: screenQueue)
        try stream!.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)

        try await stream!.startCapture()
    }

    func stop() {
        Task {
            try? await stream?.stopCapture()
            stream = nil
        }
    }

    // MARK: - SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        guard sampleBuffer.isValid, sampleBuffer.numSamples > 0 else { return }

        try? sampleBuffer.withAudioBufferList { audioBufferList, _ in
            let numBuffers = Int(audioBufferList.unsafePointer.pointee.mNumberBuffers)

            if numBuffers <= 1 {
                // Mono or already-interleaved — write directly
                let buf = audioBufferList.unsafePointer.pointee.mBuffers
                if let ptr = buf.mData, buf.mDataByteSize > 0 {
                    writeData(Data(bytes: ptr, count: Int(buf.mDataByteSize)))
                }
                return
            }

            // SCK delivers non-interleaved (planar) stereo: buffer[0]=L, buffer[1]=R.
            // FFmpeg expects interleaved f32le (LRLRLR...), so interleave here.
            // Use unsafePointer directly — do NOT copy via .pointee, which loses all
            // AudioBuffers past the first (AudioBufferList.mBuffers is a flexible array).
            let bufPtr = UnsafeRawPointer(audioBufferList.unsafePointer)
                .advanced(by: MemoryLayout<AudioBufferList>.offset(of: \.mBuffers)!)
                .assumingMemoryBound(to: AudioBuffer.self)

            var channels: [UnsafePointer<Float32>] = []
            var frameCount = 0
            for i in 0..<numBuffers {
                let buf = bufPtr[i]
                guard let ptr = buf.mData, buf.mDataByteSize > 0 else { continue }
                channels.append(ptr.assumingMemoryBound(to: Float32.self))
                if i == 0 { frameCount = Int(buf.mDataByteSize) / 4 }
            }
            guard channels.count == numBuffers, frameCount > 0 else { return }

            var interleaved = Data(count: frameCount * numBuffers * 4)
            interleaved.withUnsafeMutableBytes { raw in
                guard let out = raw.baseAddress?.assumingMemoryBound(to: Float32.self) else { return }
                for f in 0..<frameCount {
                    for c in 0..<numBuffers {
                        out[f * numBuffers + c] = channels[c][f]
                    }
                }
            }
            writeData(interleaved)
        }
    }

    private func writeData(_ data: Data) {
        do {
            try outputHandle.write(contentsOf: data)
        } catch {
            exit(0)
        }
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write(Data("Stream stopped: \(error.localizedDescription)\n".utf8))
        exit(1)
    }
}

enum CaptureError: LocalizedError {
    case noDisplay
    case appNotFound(String)

    var errorDescription: String? {
        switch self {
        case .noDisplay: return "No display found"
        case .appNotFound(let id): return "App not found: \(id)"
        }
    }
}
