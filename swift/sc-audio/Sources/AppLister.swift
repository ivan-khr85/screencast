import Foundation
import ScreenCaptureKit

struct AppInfo: Encodable {
    let pid: Int
    let name: String
    let bundleID: String
}

func listApps() async throws -> [AppInfo] {
    let content = try await SCShareableContent.excludingDesktopWindows(
        false, onScreenWindowsOnly: false
    )

    return content.applications
        .filter { !$0.bundleIdentifier.isEmpty }
        .map { app in
            AppInfo(
                pid: Int(app.processID),
                name: app.applicationName,
                bundleID: app.bundleIdentifier
            )
        }
        .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
}
