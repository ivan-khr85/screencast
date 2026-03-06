import Foundation

// MARK: - Signal Handling

var capture: AudioCapture?

func handleSignal(_ signal: Int32) {
    capture?.stop()
    exit(0)
}

signal(SIGTERM, handleSignal)
signal(SIGINT, handleSignal)

// MARK: - CLI

let args = CommandLine.arguments

func printUsage() {
    let usage = """
    Usage: sc-audio <command> [options]

    Commands:
      list                        List running apps as JSON
      capture [options]           Capture audio as raw PCM (f32le, 48kHz, stereo)

    Capture options:
      --app <bundleID>            Capture audio from specific app (default: system audio)
      --output <path>             Write to file/FIFO instead of stdout

    Examples:
      sc-audio list
      sc-audio capture
      sc-audio capture --app com.spotify.client
      sc-audio capture --output /tmp/audio.pcm
    """
    FileHandle.standardError.write(Data(usage.utf8))
}

guard args.count >= 2 else {
    printUsage()
    exit(1)
}

let command = args[1]

switch command {
case "list":
    // List available apps
    let apps = try await listApps()
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    let data = try encoder.encode(apps)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))

case "capture":
    // Parse capture options
    var appBundleID: String?
    var outputPath: String?

    var i = 2
    while i < args.count {
        switch args[i] {
        case "--app":
            i += 1
            guard i < args.count else {
                FileHandle.standardError.write(Data("Error: --app requires a bundle ID\n".utf8))
                exit(1)
            }
            appBundleID = args[i]
        case "--output":
            i += 1
            guard i < args.count else {
                FileHandle.standardError.write(Data("Error: --output requires a path\n".utf8))
                exit(1)
            }
            outputPath = args[i]
        default:
            FileHandle.standardError.write(Data("Unknown option: \(args[i])\n".utf8))
            exit(1)
        }
        i += 1
    }

    // Determine output handle
    let outputHandle: FileHandle
    if let path = outputPath {
        guard let handle = FileHandle(forWritingAtPath: path) else {
            FileHandle.standardError.write(Data("Error: cannot open \(path) for writing\n".utf8))
            exit(1)
        }
        outputHandle = handle
    } else {
        outputHandle = FileHandle.standardOutput
    }

    // Start capture
    capture = AudioCapture(outputHandle: outputHandle)
    try await capture!.start(appBundleID: appBundleID)

    // Log to stderr so it doesn't mix with PCM data on stdout
    let mode = appBundleID ?? "system"
    FileHandle.standardError.write(Data("Capturing audio: \(mode)\n".utf8))

    // Keep running — RunLoop processes dispatch and SCK callbacks
    RunLoop.main.run()

default:
    printUsage()
    exit(1)
}
