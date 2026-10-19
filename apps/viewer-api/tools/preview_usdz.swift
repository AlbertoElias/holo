// Optional macOS RealityKit visual evidence. Does not prove iPhone Quick Look.
// Build: xcrun swiftc preview_usdz.swift -o /tmp/preview-usdz
// Run: /tmp/preview-usdz model.usdz frames-directory centerX centerY centerZ radius
import AppKit
import RealityKit
import Foundation
import simd

let arguments = CommandLine.arguments
if arguments.count != 7 {
    fatalError("Usage: preview-usdz model.usdz frames-directory centerX centerY centerZ radius")
}
let destination = URL(fileURLWithPath: arguments[2])
try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
let center = SIMD3<Float>(Float(arguments[3])!, Float(arguments[4])!, Float(arguments[5])!)
let radius = Float(arguments[6])!
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let view = ARView(frame: CGRect(x: 0, y: 0, width: 960, height: 960))
let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
window.contentView = view
window.makeKeyAndOrderFront(nil)
view.environment.background = .color(.init(red: 0.035, green: 0.065, blue: 0.1, alpha: 1))
let anchor = AnchorEntity(world: .zero)
let model = try Entity.load(contentsOf: URL(fileURLWithPath: arguments[1]))
anchor.addChild(model)
let camera = PerspectiveCamera()
camera.camera.fieldOfViewInDegrees = 45
camera.look(at: center, from: center + SIMD3<Float>(radius * 1.4, radius * 0.5, radius * 2.4), relativeTo: nil)
anchor.addChild(camera)
let light = DirectionalLight()
light.light.intensity = 2000
light.look(at: center, from: center + SIMD3<Float>(5, 8, 8), relativeTo: nil)
anchor.addChild(light)
view.scene.addAnchor(anchor)
print("RealityKit loaded animations=\(model.availableAnimations.count); bounds=\(model.visualBounds(relativeTo: nil))")
// One rig animation plus optional blend animation can be imported separately.
// Play every imported resource, so no channel is omitted by this preview tool.
for animation in model.availableAnimations {
    model.playAnimation(animation.repeat(), transitionDuration: 0, startsPaused: false)
}
let frameCount = 60
let started = Date()
func snapshot(_ frame: Int) {
    view.snapshot(saveToHDR: false) { image in
        guard let image = image, let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else {
            fputs("RealityKit snapshot failed\n", stderr)
            exit(1)
        }
        do {
            try png.write(to: destination.appendingPathComponent(String(format: "frame-%03d.png", frame)))
        } catch { fatalError("Could not save preview: \(error)") }
        if frame + 1 == frameCount {
            print("Saved \(frameCount) RealityKit frames in \(Date().timeIntervalSince(started)) seconds")
            app.terminate(nil)
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / 30.0) { snapshot(frame + 1) }
        }
    }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { snapshot(0) }
DispatchQueue.main.asyncAfter(deadline: .now() + 30) { fputs("RealityKit preview timed out\n", stderr); exit(1) }
app.run()
