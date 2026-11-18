import XCTest
@testable import NekkoKit
import NekkoProtocol

/// A phone key's rate-limit headers as the limit line's windows (#2923).
final class PhoneLimitLineTests: XCTestCase {
    func testBudgetsBecomeWindowsUsedAgainstTheirLimit() {
        let r = PhoneRateLimits(requestsLimit: 500, requestsRemaining: 499, requestsResetAt: 61_000,
                                tokensLimit: 30_000, tokensRemaining: 26_400, tokensResetAt: 2_000, at: 1_000)
        let limits = r.providerLimits(now: 1_500)
        XCTAssertEqual(limits.windows.map(\.id), ["tokens", "requests"])
        XCTAssertEqual(limits.windows[0].usedPercent, 12, accuracy: 0.001)
        XCTAssertEqual(limits.windows[0].resetAt, 2_000)
        let line = LimitLine.tightest(limits)
        XCTAssertEqual(line?.window.id, "tokens")
        XCTAssertEqual(line?.level, .quiet)
    }

    func testAnEmptyBudgetIsReachedUntilItResets() {
        let r = PhoneRateLimits(tokensLimit: 10_000, tokensRemaining: 0, tokensResetAt: 5_000, at: 1_000)
        XCTAssertEqual(LimitLine.tightest(r.providerLimits(now: 2_000))?.level, .reached)
        let after = r.providerLimits(now: 5_000)
        XCTAssertEqual(after.windows.first?.usedPercent, 0)
        XCTAssertEqual(LimitLine.tightest(after)?.level, .quiet)
    }

    func testABudgetWithoutALimitOrRemainingIsLeftOut() {
        XCTAssertTrue(PhoneRateLimits(requestsLimit: 0, requestsRemaining: 0, at: 1).providerLimits(now: 1).windows.isEmpty)
        XCTAssertTrue(PhoneRateLimits(tokensLimit: 1000, at: 1).providerLimits(now: 1).windows.isEmpty)
        XCTAssertNil(LimitLine.tightest(PhoneRateLimits(at: 1).providerLimits(now: 1)))
    }
}
