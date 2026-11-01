// BGTask may be completed from any thread, but BackgroundTasks doesn't mark it
// Sendable yet: the task is handed to the main actor to complete it there.
@preconcurrency import BackgroundTasks
import Foundation

/// While prompts wait in the outbox and the app is in the background, iOS may
/// wake it now and then (`BGAppRefreshTask`) to try delivering them. When and
/// whether it runs is up to iOS; coming back to the foreground always tries.
enum OutboxRefresh {
    static let id = "dev.nekkolabs.nekkoagent.outbox"

    /// Before the app finishes launching (BackgroundTasks requires it).
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: id, using: nil) { task in
            let work = Task { @MainActor in
                let delivered = await AppModel.shared.deliverInBackground()
                task.setTaskCompleted(success: delivered)
            }
            task.expirationHandler = { work.cancel() }
        }
    }

    /// Ask for a try in a while (no sooner than iOS allows).
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: id)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    static func cancel() {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: id)
    }
}
