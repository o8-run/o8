// Prints the id of the widest on-screen window of a process, for screencapture.
import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2, let pid = Int32(CommandLine.arguments[1]) else {
    FileHandle.standardError.write("usage: window-id.swift PID\n".data(using: .utf8)!)
    exit(2)
}
let windows =
    CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]] ?? []
func width(_ window: [String: Any]) -> Double {
    ((window[kCGWindowBounds as String] as? [String: Any])?["Width"] as? NSNumber)?.doubleValue ?? 0
}
let mine = windows.filter { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid }
if let widest = mine.max(by: { width($0) < width($1) }),
    let id = widest[kCGWindowNumber as String] as? NSNumber
{
    print(id.intValue)
}
