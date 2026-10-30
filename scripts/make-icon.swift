// Draws the icon for the README and the website: docs/icon.png. (Resources/AppIcon.icns is a by-product.)
//
//   swift scripts/make-icon.swift
import AppKit

let output = CommandLine.arguments.dropFirst().first ?? FileManager.default.temporaryDirectory.appendingPathComponent("symbolhop.icns").path

/// Draws the icon on a 1024-point canvas, scaled to `pixels`.
func icon(pixels: Int) -> NSBitmapImageRep {
    let image = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: image)
    let scale = NSAffineTransform()
    scale.scale(by: CGFloat(pixels) / 1024)
    scale.concat()

    let slate = NSColor(srgbRed: 0.13, green: 0.17, blue: 0.27, alpha: 1)
    let ice = NSColor(srgbRed: 0.62, green: 0.82, blue: 1.0, alpha: 1)

    // The rounded tile, with the soft shadow macOS icons sit on. Same tile and light as Show Desktop.
    let tile = NSBezierPath(roundedRect: NSRect(x: 100, y: 100, width: 824, height: 824), xRadius: 185, yRadius: 185)
    NSGraphicsContext.saveGraphicsState()
    let tileShadow = NSShadow()
    tileShadow.shadowColor = .black.withAlphaComponent(0.3)
    tileShadow.shadowBlurRadius = 24
    tileShadow.shadowOffset = NSSize(width: 0, height: -12)
    tileShadow.set()
    slate.setFill()
    tile.fill()
    NSGraphicsContext.restoreGraphicsState()
    NSGradient(colors: [
        NSColor(srgbRed: 0.80, green: 0.87, blue: 0.96, alpha: 1),
        NSColor(srgbRed: 0.45, green: 0.57, blue: 0.75, alpha: 1),
        slate,
    ])!.draw(in: tile, angle: -90)

    /// A white shape with a soft shadow, like a sheet of paper on the tile.
    func paper(_ path: NSBezierPath, alpha: CGFloat = 0.96) {
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.28)
        shadow.shadowBlurRadius = 22
        shadow.shadowOffset = NSSize(width: 0, height: -10)
        shadow.set()
        NSColor.white.withAlphaComponent(alpha).setFill()
        path.fill()
        NSGraphicsContext.restoreGraphicsState()
    }

    // Two code cards, a call and its definition, with an ice-blue arc hopping from one to the other.
    paper(NSBezierPath(roundedRect: NSRect(x: 170, y: 190, width: 330, height: 250), xRadius: 44, yRadius: 44), alpha: 0.82)
    paper(NSBezierPath(roundedRect: NSRect(x: 524, y: 520, width: 330, height: 250), xRadius: 44, yRadius: 44))
    slate.withAlphaComponent(0.28).setFill()
    for (i, w) in [CGFloat(200), 150, 230].enumerated() {
        NSBezierPath(roundedRect: NSRect(x: 214, y: 370 - CGFloat(i) * 56, width: w, height: 26), xRadius: 13, yRadius: 13).fill()
        NSBezierPath(roundedRect: NSRect(x: 568, y: 700 - CGFloat(i) * 56, width: [CGFloat(180), 240, 130][i], height: 26), xRadius: 13, yRadius: 13).fill()
    }
    NSGraphicsContext.saveGraphicsState()
    let glow = NSShadow()
    glow.shadowColor = ice.withAlphaComponent(0.8)
    glow.shadowBlurRadius = 30
    glow.set()
    ice.setStroke()
    ice.setFill()
    let hop = NSBezierPath()
    hop.move(to: NSPoint(x: 335, y: 470))
    hop.curve(to: NSPoint(x: 600, y: 490), controlPoint1: NSPoint(x: 360, y: 700), controlPoint2: NSPoint(x: 560, y: 720))
    hop.lineWidth = 46
    hop.lineCapStyle = .round
    hop.stroke()
    let head = NSBezierPath()
    head.move(to: NSPoint(x: 540, y: 500))
    head.line(to: NSPoint(x: 680, y: 520))
    head.line(to: NSPoint(x: 600, y: 410))
    head.close()
    head.lineWidth = 24
    head.lineJoinStyle = .round
    head.fill()
    head.stroke()
    NSGraphicsContext.restoreGraphicsState()

    NSGraphicsContext.restoreGraphicsState()
    return image
}

let iconset = FileManager.default.temporaryDirectory.appendingPathComponent("AppIcon.iconset")
try? FileManager.default.removeItem(at: iconset)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let name = scale == 1 ? "icon_\(points)x\(points).png" : "icon_\(points)x\(points)@2x.png"
        let png = icon(pixels: points * scale).representation(using: .png, properties: [:])!
        try png.write(to: iconset.appendingPathComponent(name))
    }
}
try icon(pixels: 256).representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "docs/icon.png"))

let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["--convert", "icns", iconset.path, "--output", output]
try iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else { fatalError("iconutil failed") }
Swift.print("Wrote \(output) and docs/icon.png")
