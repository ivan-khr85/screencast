import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia

final class AudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var outputHandle: FileHandle
    private let sampleRate: Int
    private let channels: Int
    private var silenceTimer: DispatchSourceTimer?
    private var gotAudioRecently = false
    private let lock = NSLock()

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

        // Start silence padding timer — writes silence when no real audio arrives
        startSilenceTimer()
    }

    func stop() {
        silenceTimer?.cancel()
        silenceTimer = nil
        Task {
            try? await stream?.stopCapture()
            stream = nil
        }
    }

    // MARK: - Silence Padding

    private func startSilenceTimer() {
        // 960 samples at 48kHz = 20ms per chunk (matching SCK's default chunk size)
        let samplesPerChunk = 960
        let bytesPerSample = 4 // f32le
        let silenceChunkSize = samplesPerChunk * channels * bytesPerSample
        let silenceData = Data(count: silenceChunkSize) // all zeros = silence

        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "sc-audio.silence"))
        timer.schedule(deadline: .now(), repeating: .milliseconds(20))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let hasAudio = self.gotAudioRecently
            self.gotAudioRecently = false
            self.lock.unlock()

            if !hasAudio {
                self.writeData(silenceData)
            }
        }
        timer.resume()
        silenceTimer = timer
    }

    // MARK: - SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        guard sampleBuffer.isValid, sampleBuffer.numSamples > 0 else { return }

        lock.lock()
        gotAudioRecently = true
        lock.unlock()

        if let blockBuffer = sampleBuffer.dataBuffer {
            let length = blockBuffer.dataLength
            var data = Data(count: length)
            data.withUnsafeMutableBytes { rawPtr in
                guard let baseAddress = rawPtr.baseAddress else { return }
                CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: length, destination: baseAddress)
            }
            writeData(data)
            return
        }

        try? sampleBuffer.withAudioBufferList { audioBufferList, _ in
            for i in 0..<Int(audioBufferList.unsafePointer.pointee.mNumberBuffers) {
                let buffer: AudioBuffer
                if i == 0 {
                    buffer = audioBufferList.unsafePointer.pointee.mBuffers
                } else {
                    buffer = withUnsafePointer(to: audioBufferList.unsafePointer.pointee) { ptr in
                        let bufPtr = UnsafeRawPointer(ptr).advanced(by: MemoryLayout<AudioBufferList>.offset(of: \.mBuffers)!)
                            .assumingMemoryBound(to: AudioBuffer.self)
                        return bufPtr[i]
                    }
                }
                if let data = buffer.mData, buffer.mDataByteSize > 0 {
                    writeData(Data(bytes: data, count: Int(buffer.mDataByteSize)))
                }
            }
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
