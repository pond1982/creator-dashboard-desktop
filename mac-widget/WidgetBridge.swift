import WidgetKit

@_cdecl("reloadArgusWidgetTimelines")
public func reloadArgusWidgetTimelines() {
    WidgetCenter.shared.reloadAllTimelines()
}
