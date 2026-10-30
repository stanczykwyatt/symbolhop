// Draws the README demo (docs/demo.gif) and the link preview image (docs/social.png).
// Everything is drawn here rather than recorded, so the art never shows anyone's real desktop. The
// terminal is a drawing, and the code in it is the made-up project bench/measure.mjs generates.
//
//   swift scripts/make-art.swift
import AppKit
import ImageIO
import UniformTypeIdentifiers

let ink = NSColor(srgbRed: 0.05, green: 0.06, blue: 0.07, alpha: 1)
let ice = NSColor(srgbRed: 0.62, green: 0.82, blue: 1.0, alpha: 1)

func bitmap(_ width: Int, _ height: Int, draw: () -> Void) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    draw()
    NSGraphicsContext.restoreGraphicsState()
    return rep
}

/// Cool silver light on a dark wallpaper, like the other apps' art.
func wallpaper(_ rect: NSRect) {
    NSGradient(starting: NSColor(srgbRed: 0.08, green: 0.09, blue: 0.13, alpha: 1), ending: ink)!.draw(in: rect, angle: -90)
    let glows: [(CGFloat, CGFloat, CGFloat, NSColor)] = [
        (0.18, 0.75, 0.42, NSColor(srgbRed: 0.84, green: 0.89, blue: 0.95, alpha: 0.45)),
        (0.85, 0.72, 0.38, NSColor(srgbRed: 0.59, green: 0.68, blue: 0.81, alpha: 0.40)),
        (0.70, 0.12, 0.46, NSColor(srgbRed: 0.75, green: 0.81, blue: 0.89, alpha: 0.32)),
        (0.22, 0.15, 0.30, NSColor(srgbRed: 0.44, green: 0.53, blue: 0.65, alpha: 0.32)),
    ]
    for (x, y, r, color) in glows {
        let center = NSPoint(x: rect.minX + rect.width * x, y: rect.minY + rect.height * y)
        NSGradient(starting: color, ending: color.withAlphaComponent(0))!
            .draw(fromCenter: center, radius: 0, toCenter: center, radius: rect.width * r, options: [])
    }
}

@discardableResult
func text(
    _ string: String, at point: NSPoint, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = .white,
    centered: Bool = false, mono: Bool = false
) -> CGFloat {
    let font = mono ? NSFont.monospacedSystemFont(ofSize: size, weight: weight) : NSFont.systemFont(ofSize: size, weight: weight)
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
    let width = (string as NSString).size(withAttributes: attributes).width
    (string as NSString).draw(at: NSPoint(x: centered ? point.x - width / 2 : point.x, y: point.y), withAttributes: attributes)
    return width
}


let width: CGFloat = 720
let height: CGFloat = 450

func terminal(_ lines: [(String, NSColor)], badge: String?) -> NSBitmapImageRep {
    bitmap(Int(width), Int(height)) {
        wallpaper(NSRect(x: 0, y: 0, width: width, height: height))
        let frame = NSRect(x: 30, y: 30, width: 660, height: 390)
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = .black.withAlphaComponent(0.55)
        shadow.shadowBlurRadius = 26
        shadow.shadowOffset = NSSize(width: 0, height: -10)
        shadow.set()
        NSColor(srgbRed: 0.07, green: 0.08, blue: 0.10, alpha: 0.97).setFill()
        NSBezierPath(roundedRect: frame, xRadius: 12, yRadius: 12).fill()
        NSGraphicsContext.restoreGraphicsState()
        for (i, color) in [NSColor.systemRed, .systemYellow, .systemGreen].enumerated() {
            color.setFill()
            NSBezierPath(ovalIn: NSRect(x: frame.minX + 16 + CGFloat(i) * 20, y: frame.maxY - 24, width: 12, height: 12)).fill()
        }
        for (i, (line, color)) in lines.suffix(18).enumerated() {
            text(line, at: NSPoint(x: frame.minX + 20, y: frame.maxY - 56 - CGFloat(i) * 18.5), size: 12.5, color: color, mono: true)
        }
        if let badge {
            let box = NSRect(x: frame.maxX - 250, y: frame.minY + 16, width: 234, height: 34)
            ice.withAlphaComponent(0.16).setFill()
            NSBezierPath(roundedRect: box, xRadius: 17, yRadius: 17).fill()
            text(badge, at: NSPoint(x: box.midX, y: box.minY + 9), size: 13, weight: .semibold, color: ice, centered: true)
        }
    }
}

let dim = NSColor.white.withAlphaComponent(0.45)
let plain = NSColor.white.withAlphaComponent(0.85)
let red = NSColor(srgbRed: 1, green: 0.55, blue: 0.5, alpha: 1)
let ask: [(String, NSColor)] = [("› where is count_entries used?", .white), ("", plain)]
var grep: [(String, NSColor)] = ask + [("$ grep -rn count_entries src", ice)]
for m in 0..<9 {
    grep.append(("src/module\(m).c:4:/* Module \(m). Calls init first; see count_entries…", red))
    if m % 3 == 0 { grep.append(("src/module\(m).c:11:    s->total += count_entries(\"a,b,c\");", plain)) }
    else { grep.append(("src/module\(m).c:11:    s->total += count_entries_fast(\"a,b,c\");", red)) }
    grep.append(("src/module\(m).c:12:    printf(\"module \(m): count=%d (count_entries %s)…", red))
}
var lsp: [(String, NSColor)] = ask + [("● lsp_references  src/core.c:5  count_entries", ice)]
lsp.append(("src/app.h:6:5  int count_entries(const char *list);", plain))
lsp.append(("src/core.c:5:5  int count_entries(const char *list) {", plain))
for m in stride(from: 0, to: 24, by: 3) { lsp.append(("src/module\(m).c:11:17  s->total += count_entries(\"a,b,c\");", plain)) }

var frames: [(NSBitmapImageRep, Double)] = [(terminal(ask, badge: nil), 1.0)]
for count in stride(from: 4, through: grep.count, by: 4) { frames.append((terminal(Array(grep.prefix(count)), badge: nil), 0.12)) }
frames.append((terminal(grep, badge: "77 lines · 67 aren't uses"), 2.4))
for count in stride(from: 4, through: lsp.count, by: 3) { frames.append((terminal(Array(lsp.prefix(count)), badge: nil), 0.15)) }
frames.append((terminal(lsp, badge: "10 lines · every one a use"), 3.0))

let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: "docs/demo.gif") as CFURL, UTType.gif.identifier as CFString, frames.count, nil)!
CGImageDestinationSetProperties(destination, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
for (rep, hold) in frames {
    CGImageDestinationAddImage(destination, rep.cgImage!, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: hold]] as CFDictionary)
}
guard CGImageDestinationFinalize(destination) else { fatalError("Couldn't write the GIF") }

let social = bitmap(1280, 640) {
    wallpaper(NSRect(x: 0, y: 0, width: 1280, height: 640))
    NSImage(contentsOfFile: "docs/icon.png")!.draw(in: NSRect(x: 96, y: 380, width: 140, height: 140))
    text("symbolhop", at: NSPoint(x: 96, y: 270), size: 80, weight: .semibold)
    text("Go-to-definition and find-references for coding agents.", at: NSPoint(x: 100, y: 214), size: 30, color: .white.withAlphaComponent(0.85))
    text("10 exact lines instead of 77 from grep, in a measured example.", at: NSPoint(x: 100, y: 164), size: 22, color: ice)
    text("MCP server and CLI · uses your language servers · read-only · no dependencies", at: NSPoint(x: 100, y: 100), size: 17, color: .white.withAlphaComponent(0.5), mono: true)
}
try social.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "docs/social.png"))
Swift.print("Wrote docs/demo.gif and docs/social.png")
