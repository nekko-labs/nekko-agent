import SwiftUI
import UIKit

/// Selected photos in either composer. Position identifies a selection, so
/// identical photos remain independently removable and keep their order.
struct ComposerPhotos: View {
    let photos: [String]
    let remove: (Int) -> Void
    @State private var open: PhotoSet?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(photos.enumerated()), id: \.offset) { i, source in
                    ComposerPhoto(source: source, index: i, open: { open = PhotoSet(photos: photos, index: i) }, remove: { remove(i) })
                }
            }
            .padding(.vertical, 2)
        }
        .accessibilityIdentifier("composer.photos")
        .fullScreenCover(item: $open) { selection in ImageViewer(photos: selection.photos, index: selection.index) }
    }
}

private struct ComposerPhoto: View {
    let source: String
    let index: Int
    let open: () -> Void
    let remove: () -> Void
    @Environment(\.palette) private var palette
    @State private var thumbnail: UIImage?

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Button(action: open) {
                Group {
                    if let thumbnail {
                        Image(uiImage: thumbnail).resizable().scaledToFill()
                    } else {
                        Image(systemName: "photo").foregroundStyle(palette.inkSoft)
                    }
                }
                .frame(width: 80, height: 80).clipped()
                .background(palette.surface2)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.line))
            }
            .buttonStyle(.plain)
            .disabled(thumbnail == nil)
            .accessibilityLabel("Photo \(index + 1)")
            .accessibilityIdentifier("composer.photo.\(index)")
            // Keep the main button's centre outside the 44-point remove target.
            .padding(.top, 8).padding(.trailing, 8)
            Button(action: remove) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 22)).symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .black.opacity(0.75))
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove photo \(index + 1)")
            .accessibilityIdentifier("composer.removePhoto.\(index)")
        }
        .task(id: source) { thumbnail = DataURLImage.thumbnail(source) }
    }
}
