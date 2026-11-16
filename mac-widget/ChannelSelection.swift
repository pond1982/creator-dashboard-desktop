import AppIntents
import Foundation
import WidgetKit

@available(macOS 14.0, *)
struct WidgetYouTubeChannel: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "YouTube Channel"
    static let defaultQuery = VisibleChannelQuery()
    static let all = Self(id: "all", title: "All visible channels")

    let id: String
    let title: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)") }
}

@available(macOS 14.0, *)
struct VisibleChannelQuery: EntityQuery {
    private func choices() -> [WidgetYouTubeChannel] {
        let entry = Entry(date: .now, snapshot: .read(), mode: .subscribers, channelID: nil)
        return [.all] + entry.channels.map { WidgetYouTubeChannel(id: $0.id, title: $0.title) }
    }

    func suggestedEntities() async throws -> [WidgetYouTubeChannel] { choices() }

    func entities(for identifiers: [String]) async throws -> [WidgetYouTubeChannel] {
        let available = choices()
        // Keep an existing selection scoped to its ID after the user hides or
        // removes that channel, without retaining its title or showing others.
        return identifiers.map { id in
            available.first { $0.id == id } ?? WidgetYouTubeChannel(id: id, title: "Unavailable channel")
        }
    }
}

@available(macOS 14.0, *)
struct ChannelSelectionIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Choose a YouTube channel"
    @Parameter(title: "Channel")
    var channel: WidgetYouTubeChannel?

    var selectedID: String? { channel?.id == WidgetYouTubeChannel.all.id ? nil : channel?.id }
}

@available(macOS 14.0, *)
struct ConfigurableChannelProvider: AppIntentTimelineProvider {
    let mode: WidgetMode

    func placeholder(in context: Context) -> Entry {
        SharedTimeline.placeholder(mode: mode, channelID: nil)
    }

    func snapshot(for configuration: ChannelSelectionIntent, in context: Context) async -> Entry {
        SharedTimeline.snapshot(mode: mode, channelID: configuration.selectedID, preview: context.isPreview)
    }

    func timeline(for configuration: ChannelSelectionIntent, in context: Context) async -> Timeline<Entry> {
        SharedTimeline.timeline(mode: mode, channelID: configuration.selectedID)
    }
}
