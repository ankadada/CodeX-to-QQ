#!/usr/bin/env swift

import Foundation

#if canImport(Vision) && canImport(AppKit)
import AppKit
import Vision

guard CommandLine.arguments.count >= 2 else {
  fputs("usage: ocr-image.swift <image-path>\n", stderr)
  exit(2)
}

let imagePath = CommandLine.arguments[1]
let imageURL = URL(fileURLWithPath: imagePath)

guard let image = NSImage(contentsOf: imageURL) else {
  fputs("failed to read image\n", stderr)
  exit(1)
}

var proposedRect = CGRect.zero
guard let cgImage = image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) else {
  fputs("failed to build cgimage\n", stderr)
  exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "en-US"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

do {
  try handler.perform([request])
  let observations = request.results ?? []
  let lines = observations
    .compactMap { $0.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }
  FileHandle.standardOutput.write(lines.joined(separator: "\n").data(using: .utf8) ?? Data())
} catch {
  fputs("ocr failed: \(error.localizedDescription)\n", stderr)
  exit(1)
}

#else
fputs("vision ocr unavailable on this platform\n", stderr)
exit(1)
#endif
