import AppIntents
import Darwin
import Foundation
import SwiftUI
import WidgetKit

enum WidgetMode: Sendable {
    case subscribers, latest, sales

    var kind: String {
        switch self {
        case .subscribers: return "dev.creatordashboard.desktop.Widget"
        case .latest: return "dev.creatordashboard.desktop.LatestUpload"
        case .sales: return "dev.creatordashboard.desktop.Sales"
        }
    }

    var name: String {
        switch self {
        case .subscribers: return "YouTube Subscribers"
        case .latest: return "YouTube Latest Upload"
        case .sales: return "App Store Sales"
        }
    }

    var summary: String {
        switch self {
        case .subscribers: return "See subscriber counts and daily changes for one channel or all visible channels."
        case .latest: return "Follow your latest upload, its audience response, and recent videos."
        case .sales: return "Track paid downloads, daily reports, and developer proceeds."
        }
    }

    var icon: String {
        switch self {
        case .subscribers: return "person.2.fill"
        case .latest: return "play.rectangle.fill"
        case .sales: return "bag.fill"
        }
    }
}

private let day: TimeInterval = 86_400
private let retentionWindow = 30 * day

private func instant(_ text: String?) -> Date? {
    guard let text else { return nil }
    return (try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
        ?? (try? Date(text, strategy: .iso8601))
}

private func dayKey(_ date: Date) -> String { String(date.formatted(.iso8601).prefix(10)) }

private func dates(from: String, through: String) -> [String] {
    guard let start = instant(from + "T00:00:00Z"), let end = instant(through + "T00:00:00Z"),
          end >= start, end.timeIntervalSince(start) <= 100 * day else { return [] }
    return (0...Int(end.timeIntervalSince(start) / day)).map { dayKey(start.addingTimeInterval(Double($0) * day)) }
}

private func shortDay(_ text: String?) -> String {
    guard let text, let date = instant(String(text.prefix(10)) + "T12:00:00Z") else { return "—" }
    var style = Date.FormatStyle().month(.abbreviated).day()
    style.timeZone = TimeZone(secondsFromGMT: 0)!
    return date.formatted(style)
}

private func publicationDate(_ text: String?) -> String {
    guard let date = instant(text) else { return "Date unavailable" }
    return date.formatted(.dateTime.month(.abbreviated).day().year())
}

struct WidgetSnapshot: Decodable, Sendable {
    let version: Int
    let updatedAt: String?
    let youtubeUpdatedAt: String?
    let youtubeStale: Bool?
    let channels: [Channel]
    let sales: Sales?

    struct Channel: Decodable, Identifiable, Sendable {
        let id: String
        let title: String
        let subscribers: Int?
        let lifetimeViews: Int?
        let latest: Video?
        let studio: Studio?
        let videos: [Video]?
    }

    struct Video: Decodable, Sendable {
        let id: String?
        let title: String
        let views: Int?
        let likes: Int?
        let comments: Int?
        let publishedAt: String?
    }

    struct Studio: Decodable, Sendable {
        let from: String
        let through: String
        let views: Int?
        let estimatedMinutesWatched: Double?
        let subscribersGained: Int?
        let subscribersLost: Int?
        let updatedAt: String?
        let stale: Bool?
        let daily: [Day]?

        struct Day: Decodable, Sendable {
            let date: String
            let netSubscribers: Int?
        }
    }

    struct Sales: Decodable, Sendable {
        let from: String
        let through: String
        let reportedDays: Int
        let days: Int
        let paidDownloads: Int?
        let inAppPurchases: Int?
        let freeDownloads: Int?
        let proceeds: [String: Double]
        let topApp: TopApp?
        let updatedAt: String?
        let stale: Bool?
        let daily: [Day]?

        struct TopApp: Decodable, Sendable {
            let title: String
            let paidDownloads: Int?
            let inAppPurchases: Int?
        }

        struct Day: Decodable, Sendable {
            let date: String
            let paidDownloads: Int?
        }

        var coverage: String {
            reportedDays == days ? "\(days) days reported" : "\(reportedDays)/\(days) days reported"
        }
    }

    static func read() -> Self? {
        // Sandbox entitlement is read-only and limited to this sanitized file.
        guard let home = getpwuid(getuid())?.pointee.pw_dir else { return nil }
        let file = URL(fileURLWithPath: String(cString: home), isDirectory: true)
            .appendingPathComponent("Library/Application Support/Creator Dashboard Desktop/widget-snapshot.json")
        guard let bytes = try? Data(contentsOf: file),
              let snapshot = try? JSONDecoder().decode(Self.self, from: bytes), snapshot.version == 1 else { return nil }
        return snapshot
    }

    // Gallery previews are synthetic. Timeline entries load only the user's snapshot.
    static func preview(on date: Date) -> Self {
        let iso = date.formatted(.iso8601)
        let end = date.addingTimeInterval(-day)
        let from = dayKey(end.addingTimeInterval(-27 * day))
        let through = dayKey(end)
        let net = [1, 4, 6, -2, 0, 4, 9, 5, 1, 4, 6, 7, -1, 4, 10, 2, 7, 11, 6, 2, 9, -2, 5, 12, 7, 3, 11, 8]
        let names = ["Field Notes", "Glass House", "Sunday Editions"]
        let titles = ["Inside a working letterpress", "Making room for daylight", "The last print of the season"]
        let channels = names.enumerated().map { index, title in
            let series = zip(dates(from: from, through: through), net).map { Studio.Day(date: $0.0, netSubscribers: $0.1 + index) }
            let losses = 12 + index
            let studio = Studio(from: from, through: through, views: 8240 + index * 300, estimatedMinutesWatched: 12480,
                                subscribersGained: net.reduce(0, +) + index * net.count + losses, subscribersLost: losses,
                                updatedAt: iso, stale: false, daily: series)
            let videos = [titles[index], "The art of a slower morning", "A quiet day in the studio", "Tools of the trade"].enumerated().map { item, name in
                Video(id: "\(index)-\(item)", title: name, views: [3840, 6120, 2790, 4510][item] + index * 9,
                      likes: [216, 340, 140, 208][item], comments: [28, 45, 16, 25][item],
                      publishedAt: date.addingTimeInterval(-Double(1 + index + 4 * item) * day).formatted(.iso8601))
            }
            return Channel(id: "gallery-\(index)", title: title, subscribers: [18400, 8270, 4120][index], lifetimeViews: 461200,
                           latest: videos.first, studio: studio, videos: videos)
        }
        let start = dayKey(end.addingTimeInterval(-6 * day))
        let daily = zip(dates(from: start, through: through), [5, 8, 3, 6, 11, 7, 6]).map { Sales.Day(date: $0, paidDownloads: $1) }
        let sales = Sales(from: start, through: through, reportedDays: 7, days: 7, paidDownloads: 46, inAppPurchases: 18,
                          freeDownloads: 195, proceeds: ["USD": 126.50], topApp: .init(title: "Paper Trails", paidDownloads: 31, inAppPurchases: 12),
                          updatedAt: iso, stale: false, daily: daily)
        return Self(version: 1, updatedAt: iso, youtubeUpdatedAt: iso, youtubeStale: false, channels: channels, sales: sales)
    }
}

struct Entry: TimelineEntry, Sendable {
    let date: Date
    let snapshot: WidgetSnapshot?
    let mode: WidgetMode
    let channelID: String?

    var channels: [WidgetSnapshot.Channel] {
        guard let snapshot, let stamp = instant(snapshot.youtubeUpdatedAt),
              date.timeIntervalSince(stamp) < retentionWindow else { return [] }
        return snapshot.channels.filter { channelID == nil || $0.id == channelID }
    }

    var expiredChannels: Bool {
        guard let snapshot, !snapshot.channels.isEmpty else { return false }
        return instant(snapshot.youtubeUpdatedAt).map { date.timeIntervalSince($0) >= retentionWindow } ?? true
    }

    var studios: [WidgetSnapshot.Studio] {
        let selected = channels
        let reports = selected.compactMap { channel -> WidgetSnapshot.Studio? in
            guard let report = channel.studio, let stamp = instant(report.updatedAt),
                  date.timeIntervalSince(stamp) < retentionWindow else { return nil }
            return report
        }
        guard reports.count == selected.count, let first = reports.first,
              reports.allSatisfy({ $0.from == first.from && $0.through == first.through }) else { return [] }
        return reports
    }

    var featured: WidgetSnapshot.Channel? {
        channels.filter { $0.latest != nil }.max { ($0.latest?.publishedAt ?? "") < ($1.latest?.publishedAt ?? "") }
    }

    var updateMessage: String? {
        switch mode {
        case .sales:
            guard let sales = snapshot?.sales else { return nil }
            if sales.stale == true || outdated(sales.updatedAt, hours: 48) { return "Sales update overdue" }
        case .subscribers, .latest:
            if expiredChannels { return "Channel refresh needed" }
            if !channels.isEmpty && (snapshot?.youtubeStale == true || outdated(snapshot?.youtubeUpdatedAt, hours: 2)) { return "YouTube update overdue" }
            if mode == .subscribers && channels.contains(where: { $0.studio?.stale == true }) { return "Studio update overdue" }
        }
        return nil
    }

    private func outdated(_ stamp: String?, hours: Int) -> Bool {
        instant(stamp).map { date.timeIntervalSince($0) >= Double(hours * 3600) } ?? true
    }

    var destination: URL {
        if mode == .sales { return URL(string: "arguspip://sales")! }
        let id = channelID ?? (mode == .latest ? featured?.id : nil)
        if let id, id.range(of: #"^UC[A-Za-z0-9_-]{22}$"#, options: .regularExpression) != nil {
            return URL(string: "arguspip://youtube/" + id)!
        }
        return URL(string: "arguspip://youtube")!
    }
}

enum SharedTimeline {
    static func placeholder(mode: WidgetMode, channelID: String?) -> Entry {
        let now = Date()
        return Entry(date: now, snapshot: .preview(on: now), mode: mode, channelID: channelID)
    }

    static func snapshot(mode: WidgetMode, channelID: String?, preview: Bool) -> Entry {
        if preview { return placeholder(mode: mode, channelID: nil) }
        return Entry(date: Date(), snapshot: .read(), mode: mode, channelID: channelID)
    }

    static func timeline(mode: WidgetMode, channelID: String?) -> Timeline<Entry> {
        let now = Date()
        let data = WidgetSnapshot.read()
        var boundaries: Set<Date> = [now]
        // Scheduled entries mark aged data even when macOS defers the next reload.
        if mode == .sales {
            if let stamp = instant(data?.sales?.updatedAt) { boundaries.insert(stamp.addingTimeInterval(2 * day)) }
        } else {
            if let stamp = instant(data?.youtubeUpdatedAt) {
                boundaries.insert(stamp.addingTimeInterval(2 * 3600))
                boundaries.insert(stamp.addingTimeInterval(retentionWindow))
            }
            if mode == .subscribers {
                for channel in data?.channels ?? [] where channelID == nil || channelID == channel.id {
                    if let stamp = instant(channel.studio?.updatedAt) { boundaries.insert(stamp.addingTimeInterval(retentionWindow)) }
                }
            }
        }
        let entries = boundaries.filter { $0 >= now }.sorted().map { Entry(date: $0, snapshot: data, mode: mode, channelID: channelID) }
        return Timeline(entries: entries, policy: .after(now.addingTimeInterval(30 * 60)))
    }
}

private struct StaticProvider: TimelineProvider {
    let mode: WidgetMode
    func placeholder(in context: Context) -> Entry { SharedTimeline.placeholder(mode: mode, channelID: nil) }
    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        completion(SharedTimeline.snapshot(mode: mode, channelID: nil, preview: context.isPreview))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        completion(SharedTimeline.timeline(mode: mode, channelID: nil))
    }
}

private func count(_ value: Int?) -> String {
    guard let value else { return "—" }
    return value.formatted(.number.notation(.compactName).precision(.significantDigits(1...3)))
}

private func sum(_ values: [Int?]) -> Int? {
    guard !values.isEmpty, values.allSatisfy({ $0 != nil }) else { return nil }
    return values.compactMap { $0 }.reduce(0, +)
}

private struct TrendDay {
    let date: String
    let value: Int?
}

private extension Entry {
    var subscriberTrend: [TrendDay] {
        let reports = studios
        guard let first = reports.first else { return [] }
        let maps = reports.map { Dictionary(($0.daily ?? []).map { ($0.date, $0.netSubscribers) }, uniquingKeysWith: { previous, _ in previous }) }
        return dates(from: first.from, through: first.through).map { date in
            TrendDay(date: date, value: sum(maps.map { $0[date] ?? nil }))
        }
    }

    var salesTrend: [TrendDay] {
        (snapshot?.sales?.daily ?? []).map { TrendDay(date: $0.date, value: $0.paidDownloads) }
    }
}

private struct DailyChart: View {
    let label: String
    let values: [TrendDay]
    let color: Color
    let height: CGFloat

    private var accessibilitySummary: String {
        values.map { shortDay($0.date) + ", " + ($0.value.map(String.init) ?? "no report") }.joined(separator: ". ")
    }

    var body: some View {
        let observed = values.compactMap(\.value)
        let upper = max(0, observed.max() ?? 0), lower = min(0, observed.min() ?? 0)
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.system(size: 10, weight: .medium)).lineLimit(1).minimumScaleFactor(0.85)
            HStack(spacing: 4) {
                VStack(alignment: .trailing, spacing: 0) {
                    Text(count(upper))
                    Spacer(minLength: 1)
                    if upper != lower { Text(count(lower)) }
                }.font(.system(size: 8)).monospacedDigit().foregroundStyle(.secondary)
                Canvas { context, size in
                    guard !values.isEmpty else { return }
                    let span = CGFloat(max(1, upper - lower))
                    let slot = size.width / CGFloat(values.count)
                    let width = min(14, slot * 0.68)
                    let bottom = size.height - 1
                    let baseline = upper == lower ? bottom : max(1, bottom * CGFloat(upper) / span)
                    let grid = Color.secondary.opacity(0.25)
                    var axis = Path()
                    axis.move(to: .init(x: 0, y: baseline))
                    axis.addLine(to: .init(x: size.width, y: baseline))
                    context.stroke(axis, with: .color(grid), lineWidth: 0.7)
                    for (index, point) in values.enumerated() {
                        let x = slot * (CGFloat(index) + 0.5) - width / 2
                        if let value = point.value {
                            let y = min(bottom, max(1, baseline - bottom * CGFloat(value) / span))
                            let rect = CGRect(x: x, y: min(baseline, y) - (value == 0 ? 0.5 : 0), width: width, height: max(1, abs(y - baseline)))
                            context.fill(Path(roundedRect: rect, cornerRadius: min(2, width / 3)), with: .color(color))
                        } else {
                            // A reserved slot and hollow mark distinguish an unreported day from a reported zero.
                            let radius = min(2, slot * 0.24)
                            let circle = CGRect(x: x + width / 2 - radius, y: max(0, min(size.height - 2 * radius, baseline - radius)), width: 2 * radius, height: 2 * radius)
                            context.stroke(Path(ellipseIn: circle), with: .color(.secondary), lineWidth: 0.8)
                        }
                    }
                }
            }.frame(height: height)
            HStack {
                Text(shortDay(values.first?.date))
                Spacer(minLength: 2)
                if observed.count < values.count {
                    Text("○ missing").accessibilityHidden(true)
                    Spacer(minLength: 2)
                }
                Text(shortDay(values.last?.date))
            }.font(.system(size: 9)).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(accessibilitySummary)
    }
}

private struct ReportView: View {
    let entry: Entry
    let family: WidgetFamily
    @Environment(\.colorScheme) private var scheme

    private var small: Bool { family == .systemSmall }
    private var large: Bool { family == .systemLarge }
    private var tint: Color {
        switch (entry.mode, scheme == .dark) {
        case (.subscribers, true): return Color(red: 0.47, green: 0.91, blue: 0.79)
        case (.subscribers, false): return Color(red: 0.04, green: 0.39, blue: 0.31)
        case (.latest, true): return Color(red: 0.78, green: 0.75, blue: 1)
        case (.latest, false): return Color(red: 0.35, green: 0.24, blue: 0.59)
        case (.sales, true): return Color(red: 1, green: 0.76, blue: 0.50)
        case (.sales, false): return Color(red: 0.52, green: 0.27, blue: 0.05)
        }
    }

    private var background: LinearGradient {
        let dark = scheme == .dark
        let top: Color
        switch entry.mode {
        case .subscribers: top = dark ? Color(red: 0.10, green: 0.18, blue: 0.18) : Color(red: 0.90, green: 0.97, blue: 0.94)
        case .latest: top = dark ? Color(red: 0.16, green: 0.14, blue: 0.23) : Color(red: 0.95, green: 0.93, blue: 0.99)
        case .sales: top = dark ? Color(red: 0.20, green: 0.16, blue: 0.13) : Color(red: 1, green: 0.95, blue: 0.89)
        }
        return LinearGradient(colors: [top, dark ? Color(red: 0.075, green: 0.085, blue: 0.11) : Color(white: 0.985)],
                              startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    private func header(_ title: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: entry.mode.icon).font(.system(size: 10, weight: .bold)).foregroundStyle(tint)
                .frame(width: 17, height: 17).background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 5)).widgetAccentable()
                .accessibilityHidden(true)
            Text(title).font(.system(size: small ? 11 : 12, weight: .semibold)).lineLimit(1).truncationMode(.tail)
            if entry.updateMessage != nil {
                Image(systemName: "clock.badge.exclamationmark").font(.system(size: 10)).foregroundStyle(.secondary)
                    .accessibilityLabel(entry.updateMessage ?? "")
            }
        }
    }

    private func hero(_ value: Int?, title: String, note: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(count(value)).font(.system(size: large ? 40 : 34, weight: .semibold, design: .rounded))
                .monospacedDigit().foregroundStyle(tint).widgetAccentable().lineLimit(1).minimumScaleFactor(0.66)
            Text(title).font(.system(size: 11, weight: .medium)).lineLimit(1)
            if let note { caption(note) }
        }.accessibilityElement(children: .combine)
    }

    private func caption(_ text: String, lines: Int = 1) -> some View {
        Text(text).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(lines).minimumScaleFactor(0.90)
    }

    private func section(_ text: String) -> some View {
        Text(text).font(.system(size: 11, weight: .semibold)).lineLimit(1)
    }

    private func line(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(label).lineLimit(1)
            Spacer(minLength: 2)
            Text(value).monospacedDigit().fontWeight(.medium).lineLimit(1).layoutPriority(1)
        }.font(.system(size: 11)).accessibilityElement(children: .combine)
    }

    private func stat(_ value: Int?, _ title: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(count(value)).font(.system(size: 17, weight: .semibold, design: .rounded)).monospacedDigit()
            caption(title)
        }.frame(maxWidth: .infinity, alignment: .leading).accessibilityElement(children: .combine)
    }

    private func datedFooter(_ text: String) -> some View {
        caption(entry.updateMessage ?? text)
    }

    private var publicFooter: String {
        instant(entry.snapshot?.youtubeUpdatedAt).map { "Updated " + $0.formatted(date: .abbreviated, time: .shortened) } ?? ""
    }

    private func empty(_ heading: String, _ message: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            header(heading)
            Spacer(minLength: 2)
            Text(message).font(.system(size: small ? 15 : 18, weight: .semibold, design: .rounded)).lineLimit(2)
            caption(detail, lines: 3)
            Spacer(minLength: 0)
        }
    }

    private var channelTitle: String {
        entry.channels.count > 1 ? "All channels" : entry.channels.first?.title ?? "YouTube"
    }

    @ViewBuilder private func channelEmpty(_ title: String) -> some View {
        if entry.expiredChannels { empty(title, "Refresh needed", "Open the app for current channel data.") }
        else if entry.channelID != nil { empty(title, "Channel unavailable", "Edit this widget to choose a visible channel.") }
        else { empty(title, "No channels yet", "Connect YouTube and choose a visible channel in Settings.") }
    }

    @ViewBuilder private func subscribers(_ channels: [WidgetSnapshot.Channel]) -> some View {
        let total = sum(channels.map(\.subscribers))
        let trend = entry.subscriberTrend
        let hasTrend = trend.contains { $0.value != nil }
        let totalNote = total == nil ? "Count unavailable" : (channels.count > 1 ? "\(channels.count) channels · rounded" : "Public count · rounded")
        VStack(alignment: .leading, spacing: large ? 5 : 3) {
            header(channelTitle)
            if large {
                HStack(alignment: .center, spacing: 8) {
                    hero(total, title: "Subscribers", note: totalNote)
                    Spacer(minLength: 1)
                    if let studio = entry.studios.first {
                        VStack(alignment: .trailing, spacing: 3) {
                            let gained = sum(entry.studios.map(\.subscribersGained))
                            let lost = sum(entry.studios.map(\.subscribersLost))
                            Text(count(gained) + " gained · " + count(lost) + " lost").font(.system(size: 11, weight: .medium))
                            caption(shortDay(studio.from) + " – " + shortDay(studio.through))
                        }
                    }
                }
                if hasTrend {
                    DailyChart(label: "Net subscribers per day", values: trend, color: tint, height: 39)
                }
                if !hasTrend { caption("Daily Studio data unavailable for this selection.", lines: 2) }
                Divider()
                if channels.count > 1 {
                    section("Subscribers by channel")
                    ForEach(Array(channels.prefix(3))) { ch in line(ch.title, count(ch.subscribers)) }
                    if channels.count > 3 { caption("+\(channels.count - 3) more") }
                } else if let ch = channels.first {
                    line("Lifetime channel views", count(ch.lifetimeViews))
                    if let studio = entry.studios.first { line("Views in Studio period", count(studio.views)) }
                }
                Spacer(minLength: 0)
                datedFooter(publicFooter)
            } else if small {
                Spacer(minLength: 1)
                hero(total, title: "Subscribers", note: totalNote)
                Spacer(minLength: 1)
                if let first = entry.studios.first,
                   let gained = sum(entry.studios.map(\.subscribersGained)), let lost = sum(entry.studios.map(\.subscribersLost)) {
                    let net = gained - lost
                    datedFooter("\(net >= 0 ? "+" : "")\(count(net)) net · \(dates(from: first.from, through: first.through).count)d")
                } else { datedFooter("YouTube") }
            } else {
                Spacer(minLength: 0)
                HStack(alignment: .center, spacing: 12) {
                    hero(total, title: "Subscribers", note: totalNote).frame(maxWidth: .infinity, alignment: .leading)
                    if hasTrend {
                        DailyChart(label: "Net subscribers per day", values: trend, color: tint, height: 35).frame(maxWidth: .infinity)
                    } else { caption("Daily Studio data unavailable for this selection.", lines: 3).frame(maxWidth: .infinity, alignment: .leading) }
                }
                Spacer(minLength: 0)
                datedFooter(publicFooter)
            }
        }
    }

    private func videoTitle(_ title: String) -> some View {
        Text(title).font(.system(size: large ? 21 : (small ? 14 : 17), weight: .semibold)).lineLimit(small || large ? 2 : 1)
            .minimumScaleFactor(0.94).frame(maxWidth: .infinity, alignment: .leading)
    }

    private func recentVideos(_ videos: [WidgetSnapshot.Video]) -> some View {
        let recent = Array(videos.prefix(4))
        let maxViews = max(1, recent.compactMap(\.views).max() ?? 0)
        return VStack(alignment: .leading, spacing: 6) {
            section("Recent uploads · cumulative views")
            ForEach(recent.indices, id: \.self) { i in
                HStack(spacing: 7) {
                    Text(recent[i].title).font(.system(size: 10)).lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    GeometryReader { geo in
                        if let views = recent[i].views, views > 0 {
                            Capsule().fill(tint.opacity(0.82)).frame(width: max(1, geo.size.width * CGFloat(views) / CGFloat(maxViews)))
                        }
                    }.frame(width: 50, height: 4).accessibilityHidden(true)
                    Text(count(recent[i].views)).font(.system(size: 10, weight: .medium)).monospacedDigit().frame(width: 39, alignment: .trailing)
                }.accessibilityElement(children: .combine)
            }
        }
    }

    @ViewBuilder private func latest(_ ch: WidgetSnapshot.Channel, _ video: WidgetSnapshot.Video) -> some View {
        VStack(alignment: .leading, spacing: large ? 8 : 3) {
            header(ch.title)
            if small {
                videoTitle(video.title)
                Spacer(minLength: 0)
                Text(count(video.views) + " views").font(.system(size: 14, weight: .semibold)).foregroundStyle(tint).widgetAccentable()
                HStack(spacing: 7) {
                    Label(count(video.likes), systemImage: "hand.thumbsup").accessibilityLabel("\(count(video.likes)) likes")
                    Label(count(video.comments), systemImage: "bubble.left").accessibilityLabel("\(count(video.comments)) comments")
                }.font(.system(size: 10))
                caption(shortDay(video.publishedAt))
            } else {
                videoTitle(video.title)
                caption("Latest upload · " + publicationDate(video.publishedAt))
                Spacer(minLength: 0)
                HStack { stat(video.views, "Views"); stat(video.likes, "Likes"); stat(video.comments, "Comments") }
                if large {
                    Divider()
                    if let videos = ch.videos, !videos.isEmpty { recentVideos(videos) }
                    else { line("Channel lifetime views", count(ch.lifetimeViews)) }
                    Spacer(minLength: 0)
                    datedFooter(publicFooter)
                } else if let warning = entry.updateMessage { caption(warning) }
            }
        }
    }

    @ViewBuilder private func sales(_ report: WidgetSnapshot.Sales) -> some View {
        let range = shortDay(report.from) + " – " + shortDay(report.through)
        let trend = entry.salesTrend
        let hasTrend = trend.contains { $0.value != nil }
        VStack(alignment: .leading, spacing: 3) {
            header("All apps")
            if small {
                Spacer(minLength: 0)
                hero(report.paidDownloads, title: "Paid downloads", note: report.coverage)
                Spacer(minLength: 0)
                caption(range)
            } else if large {
                HStack(alignment: .lastTextBaseline) {
                    hero(report.paidDownloads, title: "Paid downloads", note: report.coverage)
                    Spacer(minLength: 2)
                    caption(range)
                }
                if hasTrend {
                    DailyChart(label: "Paid downloads per day", values: trend, color: tint, height: 37)
                }
                HStack { stat(report.freeDownloads, "Free downloads"); stat(report.inAppPurchases, "In-app purchases") }
                Divider()
                if let app = report.topApp {
                    section("Top app by paid units")
                    line(app.title, count(sum([app.paidDownloads, app.inAppPurchases])) + " units")
                }
                let currencies = report.proceeds.keys.sorted { ($0 == "USD" ? "" : $0) < ($1 == "USD" ? "" : $1) }
                ForEach(Array(currencies.prefix(2)), id: \.self) { currency in
                    let amount = (report.proceeds[currency] ?? 0).formatted(.currency(code: currency).presentation(.isoCode))
                    line("Est. proceeds", amount)
                }
                Spacer(minLength: 0)
                datedFooter(currencies.count > 2 ? "+\(currencies.count - 2) more currencies" : instant(report.updatedAt).map { "Updated " + $0.formatted(date: .abbreviated, time: .shortened) } ?? range)
            } else {
                Spacer(minLength: 0)
                HStack(alignment: .center, spacing: 12) {
                    hero(report.paidDownloads, title: "Paid downloads", note: report.coverage).frame(maxWidth: .infinity, alignment: .leading)
                    if hasTrend {
                        DailyChart(label: "Paid downloads per day", values: trend, color: tint, height: 35).frame(maxWidth: .infinity)
                    } else { stat(report.inAppPurchases, "In-app purchases") }
                }
                Spacer(minLength: 0)
                datedFooter(range)
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch entry.mode {
        case .subscribers:
            if entry.channels.isEmpty { channelEmpty("Subscribers") } else { subscribers(entry.channels) }
        case .latest:
            if let ch = entry.featured, let video = ch.latest { latest(ch, video) }
            else if entry.channels.isEmpty { channelEmpty("Latest upload") }
            else { empty(channelTitle, "No uploads yet", "The newest public video will appear here.") }
        case .sales:
            if let report = entry.snapshot?.sales {
                if report.reportedDays > 0 { sales(report) }
                else { empty("App Store sales", "Reports pending", "No daily reports for " + shortDay(report.from) + " – " + shortDay(report.through) + ".") }
            } else { empty("App Store sales", "No sales data yet", "Connect App Store Connect and enable sales in Settings.") }
        }
    }

    var body: some View {
        if #available(macOS 14.0, *) {
            content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .privacySensitive().containerBackground(for: .widget) { background }.widgetURL(entry.destination)
        } else {
            content.padding(12).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .privacySensitive().background(background).widgetURL(entry.destination)
        }
    }
}

private struct WidgetEntryView: View {
    let entry: Entry
    @Environment(\.widgetFamily) private var family
    var body: some View { ReportView(entry: entry, family: family) }
}

private struct StaticChannelWidget: Widget {
    let mode: WidgetMode
    init() { mode = .subscribers }
    init(mode: WidgetMode) { self.mode = mode }
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: mode.kind, provider: StaticProvider(mode: mode)) { WidgetEntryView(entry: $0) }
            .configurationDisplayName(Text(mode.name)).description(Text(mode.summary))
            .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

@available(macOS 14.0, *)
private struct EditableChannelWidget: Widget {
    let mode: WidgetMode
    init() { mode = .subscribers }
    init(mode: WidgetMode) { self.mode = mode }
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: mode.kind, intent: ChannelSelectionIntent.self, provider: ConfigurableChannelProvider(mode: mode)) {
            WidgetEntryView(entry: $0)
        }
        .configurationDisplayName(Text(mode.name)).description(Text(mode.summary))
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

private struct SalesWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetMode.sales.kind, provider: StaticProvider(mode: .sales)) { WidgetEntryView(entry: $0) }
            .configurationDisplayName("App Store Sales").description(Text(WidgetMode.sales.summary))
            .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

private struct VenturaWidgets: WidgetBundle {
    var body: some Widget {
        StaticChannelWidget(mode: .subscribers)
        StaticChannelWidget(mode: .latest)
        SalesWidget()
    }
}

@available(macOS 14.0, *)
private struct EditableWidgets: WidgetBundle {
    var body: some Widget {
        EditableChannelWidget(mode: .subscribers)
        EditableChannelWidget(mode: .latest)
        SalesWidget()
    }
}

// Register each kind exactly once using the configuration supported by the host.
@main
enum ArgusPipWidget {
    @MainActor static func main() {
        if #available(macOS 14.0, *) { EditableWidgets.main() }
        else { VenturaWidgets.main() }
    }
}
