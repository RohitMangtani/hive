// send-return.swift
// Sends a HID-level Return keystroke via CGEvent.
// Required for Hive auto-pilot: AppleScript `do script` can type text
// but can't press Enter in Claude Code's ink runtime (needs \r, not \n).
//
// Compile: swiftc -o ~/send-return tools/send-return.swift
// Requires: Accessibility permission for the compiled binary

import Foundation
import CoreGraphics

let keyCode: CGKeyCode = 36 // Return key

guard let downEvent = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
      let upEvent   = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
else {
    fputs("Failed to create CGEvent\n", stderr)
    exit(1)
}

downEvent.post(tap: .cghidEventTap)
upEvent.post(tap: .cghidEventTap)
