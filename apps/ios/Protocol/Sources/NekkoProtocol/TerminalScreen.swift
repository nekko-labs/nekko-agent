import Foundation

// A small terminal emulator for the phone's terminal screen (IO-33 FA-3):
// enough of VT100/xterm for shells, prompts, `ls --color`, progress bars and
// simple full-screen programs, without a full xterm.
//
// Handled: printable text with wide (CJK, emoji) and combining characters;
// CR, LF, BS, TAB, BEL; SGR (bold, dim, italic, underline, inverse,
// strikethrough, 16 / 256 / 24-bit colours); cursor moves (CUU CUD CUF CUB
// CNL CPL CHA VPA CUP HVP), erase in line and display (EL, ED incl. 3),
// insert and delete of characters and lines (ICH DCH ECH IL DL), scroll up and
// down (SU SD), scroll regions (DECSTBM), index and reverse index, save and
// restore cursor (DECSC / DECRC, CSI s / u), the alternate screen (47, 1047,
// 1049), autowrap (7), cursor keys mode (1), cursor visibility (25) and
// bracketed paste (2004); OSC titles. Everything else is parsed and ignored.
//
// Not handled: replies to queries (DSR, DA: the desktop's own terminal
// answers those), character sets and line drawing, double width lines,
// mouse reporting, reflow of wrapped lines on resize, and the scroll-back of
// the alternate screen. The scroll-back keeps the newest `scrollbackLimit` lines.

/// A colour as the program asked for it; the app maps it to its palette.
public enum TermColor: Equatable, Hashable, Sendable {
    case `default`
    /// 0–7 normal, 8–15 bright, 16–255 the xterm cube and greys.
    case palette(UInt8)
    case rgb(UInt8, UInt8, UInt8)
}

public struct TermStyle: Equatable, Hashable, Sendable {
    public var fg: TermColor = .default
    public var bg: TermColor = .default
    public var bold = false
    public var dim = false
    public var italic = false
    public var underline = false
    public var inverse = false
    public var strike = false

    public init() {}

    public static let plain = TermStyle()
}

public struct TermCell: Equatable, Sendable {
    public var text: String
    public var style: TermStyle
    /// The right half of a wide character: drawn by the cell before it.
    public var continuation: Bool

    public static let blank = TermCell(text: " ", style: .plain, continuation: false)

    public init(text: String, style: TermStyle, continuation: Bool = false) {
        self.text = text
        self.style = style
        self.continuation = continuation
    }
}

/// One line as runs of equally styled text, trailing blanks dropped.
public struct TermLine: Equatable, Sendable {
    public struct Run: Equatable, Sendable {
        public let text: String
        public let style: TermStyle
    }

    public let runs: [Run]
    public var text: String { runs.map(\.text).joined() }
}

/// A VT screen: grid, cursor, scrollback and parser state, mutated by `feed`.
/// Not `Sendable` (it has no lock): it stays in its owner's isolation domain,
/// the main-actor `TerminalSession`.
public final class TerminalScreen {
    public private(set) var cols: Int
    public private(set) var rows: Int
    public private(set) var cursorX = 0
    public private(set) var cursorY = 0
    /// The program asked for application cursor keys (arrows send `ESC O A`).
    public private(set) var appCursor = false
    /// The program asked for bracketed paste.
    public private(set) var bracketedPaste = false
    public private(set) var cursorVisible = true
    public private(set) var altScreen = false
    public private(set) var title: String?
    public let scrollbackLimit: Int

    private var lines: [[TermCell]]
    private var scrollback: [[TermCell]] = []
    private var savedMain: (lines: [[TermCell]], x: Int, y: Int)?
    private var style = TermStyle()
    private var saved: (x: Int, y: Int, style: TermStyle)?
    private var top = 0
    private var bottom: Int
    private var autowrap = true
    private var wrapPending = false

    private enum State { case ground, escape, csi, osc, oscEscape, string, stringEscape, skipOne }
    private var state = State.ground
    private var params = ""
    private var intermediates = ""
    private var osc = ""

    public init(cols: Int = 80, rows: Int = 24, scrollbackLimit: Int = 1000) {
        self.cols = max(cols, 1)
        self.rows = max(rows, 1)
        self.scrollbackLimit = scrollbackLimit
        lines = Array(repeating: Array(repeating: .blank, count: max(cols, 1)), count: max(rows, 1))
        bottom = max(rows, 1) - 1
    }

    /// Back to an empty screen of the same size, as a fresh terminal.
    public func reset() {
        let (c, r) = (cols, rows)
        lines = Array(repeating: Array(repeating: .blank, count: c), count: r)
        scrollback = []
        savedMain = nil
        style = TermStyle()
        saved = nil
        cursorX = 0
        cursorY = 0
        top = 0
        bottom = r - 1
        autowrap = true
        wrapPending = false
        appCursor = false
        bracketedPaste = false
        cursorVisible = true
        altScreen = false
        state = .ground
        params = ""
        intermediates = ""
        osc = ""
    }

    // MARK: Feeding

    public func feed(_ text: String) {
        for u in text.unicodeScalars { step(u) }
    }

    private func step(_ u: Unicode.Scalar) {
        let v = u.value
        switch state {
        case .ground:
            if v == 0x1b { state = .escape } else if v < 0x20 || v == 0x7f { control(v) } else { put(u) }
        case .escape:
            escape(u)
        case .csi:
            if v == 0x1b {
                state = .escape
            } else if v < 0x20 {
                control(v)
            } else if (0x30...0x3f).contains(v) {
                if params.unicodeScalars.count < 64 { params.unicodeScalars.append(u) }
            } else if (0x20...0x2f).contains(v) {
                if intermediates.unicodeScalars.count < 4 { intermediates.unicodeScalars.append(u) }
            } else if (0x40...0x7e).contains(v) {
                state = .ground
                csi(Character(u))
            } else {
                state = .ground
            }
        case .osc:
            if v == 0x07 { endOsc() } else if v == 0x1b { state = .oscEscape } else if osc.unicodeScalars.count < 512 { osc.unicodeScalars.append(u) }
        case .oscEscape:
            // ESC \ ends it; anything else ends it too, then is read afresh.
            endOsc()
            if v != 0x5c { step(u) }
        case .string:
            if v == 0x1b { state = .stringEscape } else if v == 0x07 { state = .ground }
        case .stringEscape:
            state = v == 0x5c ? .ground : .string
        case .skipOne:
            state = .ground
        }
    }

    private func control(_ v: UInt32) {
        switch v {
        case 0x08:
            if cursorX > 0 { cursorX -= 1 }
            wrapPending = false
        case 0x09:
            cursorX = min((cursorX / 8 + 1) * 8, cols - 1)
            wrapPending = false
        case 0x0a, 0x0b, 0x0c:
            lineFeed()
        case 0x0d:
            cursorX = 0
            wrapPending = false
        default:
            break // BEL and the rest
        }
    }

    private func escape(_ u: Unicode.Scalar) {
        state = .ground
        switch u {
        case "[":
            state = .csi
            params = ""
            intermediates = ""
        case "]":
            state = .osc
            osc = ""
        case "P", "X", "^", "_":
            state = .string
        case "(", ")", "*", "+", "#", "%":
            state = .skipOne
        case "7": saveCursor()
        case "8": restoreCursor()
        case "D": lineFeed()
        case "E":
            cursorX = 0
            lineFeed()
        case "M": reverseIndex()
        case "c": reset()
        default: break
        }
    }

    private func endOsc() {
        state = .ground
        let parts = osc.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false)
        if parts.count == 2, parts[0] == "0" || parts[0] == "2" { title = String(parts[1]) }
        osc = ""
    }

    // MARK: Text

    private static func isWide(_ v: UInt32) -> Bool {
        switch v {
        case 0x1100...0x115f, 0x2e80...0x303e, 0x3041...0x33ff, 0x3400...0x4dbf, 0x4e00...0x9fff, 0xa000...0xa4cf,
             0xac00...0xd7a3, 0xf900...0xfaff, 0xfe30...0xfe4f, 0xff00...0xff60, 0xffe0...0xffe6,
             0x1f300...0x1f64f, 0x1f900...0x1f9ff, 0x1fa70...0x1faff, 0x20000...0x3fffd:
            return true
        default:
            return false
        }
    }

    /// Joins the character before it (accents, variation selectors, ZWJ sequences).
    private static func isJoining(_ u: Unicode.Scalar) -> Bool {
        let v = u.value
        if v == 0x200d || (0xfe00...0xfe0f).contains(v) || (0x1f3fb...0x1f3ff).contains(v) || (0xe0020...0xe007f).contains(v) { return true }
        switch u.properties.generalCategory {
        case .nonspacingMark, .enclosingMark, .spacingMark: return true
        default: return false
        }
    }

    private var lastPut: (x: Int, y: Int)?
    private var afterJoiner = false

    private func put(_ u: Unicode.Scalar) {
        if Self.isJoining(u) || afterJoiner, let at = lastPut, at.y < rows, at.x < cols {
            lines[at.y][at.x].text.unicodeScalars.append(u)
            afterJoiner = u.value == 0x200d
            return
        }
        afterJoiner = false
        let wide = Self.isWide(u.value)
        let width = wide ? 2 : 1
        if wrapPending {
            if autowrap {
                cursorX = 0
                lineFeed()
            }
            wrapPending = false
        }
        if width == 2 && cursorX == cols - 1 && cols > 1 {
            if autowrap {
                lines[cursorY][cursorX] = blank()
                cursorX = 0
                lineFeed()
            } else {
                return
            }
        }
        lines[cursorY][cursorX] = TermCell(text: String(Character(u)), style: style)
        lastPut = (cursorX, cursorY)
        if width == 2 && cursorX + 1 < cols {
            lines[cursorY][cursorX + 1] = TermCell(text: "", style: style, continuation: true)
        }
        cursorX += width
        if cursorX >= cols {
            cursorX = cols - 1
            wrapPending = autowrap
        }
    }

    private func blank() -> TermCell {
        var s = TermStyle()
        s.bg = style.bg
        return TermCell(text: " ", style: s)
    }

    private func blankLine() -> [TermCell] {
        Array(repeating: blank(), count: cols)
    }

    // MARK: Moving and scrolling

    private func lineFeed() {
        wrapPending = false
        if cursorY == bottom {
            scrollUp(1)
        } else if cursorY < rows - 1 {
            cursorY += 1
        }
    }

    private func reverseIndex() {
        wrapPending = false
        if cursorY == top { scrollDown(1) } else if cursorY > 0 { cursorY -= 1 }
    }

    private func scrollUp(_ n: Int) {
        for _ in 0..<min(n, bottom - top + 1) {
            let gone = lines.remove(at: top)
            if top == 0 && !altScreen {
                scrollback.append(gone)
                if scrollback.count > scrollbackLimit { scrollback.removeFirst(scrollback.count - scrollbackLimit) }
            }
            lines.insert(blankLine(), at: bottom)
        }
    }

    private func scrollDown(_ n: Int) {
        for _ in 0..<min(n, bottom - top + 1) {
            lines.remove(at: bottom)
            lines.insert(blankLine(), at: top)
        }
    }

    private func moveTo(x: Int, y: Int) {
        cursorX = min(max(x, 0), cols - 1)
        cursorY = min(max(y, 0), rows - 1)
        wrapPending = false
    }

    private func saveCursor() {
        saved = (cursorX, cursorY, style)
    }

    private func restoreCursor() {
        guard let s = saved else { return moveTo(x: 0, y: 0) }
        style = s.style
        moveTo(x: s.x, y: s.y)
    }

    // MARK: CSI

    private func numbers() -> [Int] {
        let body = params.drop(while: { "?<>=".contains($0) })
        return body.split(separator: ";", omittingEmptySubsequences: false).map { part in
            // `38:2:r:g:b` sub-parameters: the first number stands for the part here.
            Int(part.split(separator: ":").first ?? "") ?? 0
        }
    }

    private func csi(_ final: Character) {
        let isPrivate = params.hasPrefix("?")
        let p = numbers()
        let n = max(p.first ?? 1, 1)
        let n0 = p.first ?? 0
        guard intermediates.isEmpty else { return }
        switch final {
        case "m":
            if !isPrivate && !params.hasPrefix(">") { sgr() }
        case "A": moveTo(x: cursorX, y: cursorY - n)
        case "B", "e": moveTo(x: cursorX, y: cursorY + n)
        case "C", "a": moveTo(x: cursorX + n, y: cursorY)
        case "D": moveTo(x: cursorX - n, y: cursorY)
        case "E": moveTo(x: 0, y: cursorY + n)
        case "F": moveTo(x: 0, y: cursorY - n)
        case "G", "`": moveTo(x: n - 1, y: cursorY)
        case "d": moveTo(x: cursorX, y: n - 1)
        case "H", "f":
            let row = max(p.first ?? 1, 1)
            let col = max(p.count > 1 ? p[1] : 1, 1)
            moveTo(x: col - 1, y: row - 1)
        case "J": eraseDisplay(n0)
        case "K": eraseLine(n0)
        case "L": insertLines(n)
        case "M": deleteLines(n)
        case "P": deleteChars(n)
        case "@": insertChars(n)
        case "X":
            for x in cursorX..<min(cursorX + n, cols) { lines[cursorY][x] = blank() }
        case "S": scrollUp(n)
        case "T": if !isPrivate { scrollDown(n) }
        case "r":
            let t = max(p.first ?? 1, 1) - 1
            let b = min(p.count > 1 && p[1] > 0 ? p[1] : rows, rows) - 1
            if t < b {
                top = t
                bottom = b
                moveTo(x: 0, y: 0)
            }
        case "s": if !isPrivate { saveCursor() }
        case "u": if !isPrivate { restoreCursor() }
        case "h", "l":
            if isPrivate { for mode in p { privateMode(mode, on: final == "h") } }
        default:
            break // DSR, DA, window ops: the desktop's terminal answers queries
        }
    }

    private func eraseDisplay(_ mode: Int) {
        switch mode {
        case 0:
            eraseLine(0)
            for y in (cursorY + 1)..<rows { lines[y] = blankLine() }
        case 1:
            eraseLine(1)
            for y in 0..<cursorY { lines[y] = blankLine() }
        case 2:
            for y in 0..<rows { lines[y] = blankLine() }
        case 3:
            scrollback = []
            for y in 0..<rows { lines[y] = blankLine() }
        default:
            break
        }
    }

    private func eraseLine(_ mode: Int) {
        let range: Range<Int>
        switch mode {
        case 0: range = cursorX..<cols
        case 1: range = 0..<min(cursorX + 1, cols)
        case 2: range = 0..<cols
        default: return
        }
        for x in range { lines[cursorY][x] = blank() }
    }

    private func insertLines(_ n: Int) {
        guard cursorY >= top && cursorY <= bottom else { return }
        for _ in 0..<min(n, bottom - cursorY + 1) {
            lines.remove(at: bottom)
            lines.insert(blankLine(), at: cursorY)
        }
        cursorX = 0
    }

    private func deleteLines(_ n: Int) {
        guard cursorY >= top && cursorY <= bottom else { return }
        for _ in 0..<min(n, bottom - cursorY + 1) {
            lines.remove(at: cursorY)
            lines.insert(blankLine(), at: bottom)
        }
        cursorX = 0
    }

    private func deleteChars(_ n: Int) {
        var line = lines[cursorY]
        let k = min(n, cols - cursorX)
        line.removeSubrange(cursorX..<(cursorX + k))
        line.append(contentsOf: Array(repeating: blank(), count: k))
        lines[cursorY] = line
    }

    private func insertChars(_ n: Int) {
        var line = lines[cursorY]
        let k = min(n, cols - cursorX)
        line.insert(contentsOf: Array(repeating: blank(), count: k), at: cursorX)
        line.removeLast(k)
        lines[cursorY] = line
    }

    private func privateMode(_ mode: Int, on: Bool) {
        switch mode {
        case 1: appCursor = on
        case 7: autowrap = on
        case 25: cursorVisible = on
        case 2004: bracketedPaste = on
        case 47, 1047, 1049:
            if on && !altScreen {
                if mode == 1049 { saveCursor() }
                savedMain = (lines, cursorX, cursorY)
                altScreen = true
                lines = Array(repeating: blankLine(), count: rows)
            } else if !on && altScreen, let main = savedMain {
                altScreen = false
                lines = main.lines
                savedMain = nil
                if mode == 1049 { restoreCursor() }
            }
            top = 0
            bottom = rows - 1
        default:
            break
        }
    }

    private func sgr() {
        let raw = params.split(separator: ";", omittingEmptySubsequences: false).map(String.init)
        var codes: [[Int]] = raw.map { $0.split(separator: ":", omittingEmptySubsequences: false).map { Int($0) ?? 0 } }
        if codes.isEmpty { codes = [[0]] }
        var i = 0
        func extended(_ sub: [Int]) -> TermColor? {
            // `38:5:n` / `38:2:r:g:b` in one parameter, or `38;5;n` / `38;2;r;g;b` across several.
            var rest: [Int]
            if sub.count > 1 {
                rest = Array(sub.dropFirst())
            } else {
                rest = codes[(i + 1)...].prefix(4).map { $0.first ?? 0 }
            }
            func byte(_ v: Int) -> UInt8 { UInt8(clamping: v) }
            if rest.first == 5, rest.count >= 2 {
                if sub.count <= 1 { i += 2 }
                return .palette(byte(rest[1]))
            }
            if rest.first == 2 {
                // A colour-space id may sit before r:g:b in the colon form.
                let rgb = sub.count > 5 ? Array(rest.dropFirst(2)) : Array(rest.dropFirst())
                guard rgb.count >= 3 else { return nil }
                if sub.count <= 1 { i += 4 }
                return .rgb(byte(rgb[0]), byte(rgb[1]), byte(rgb[2]))
            }
            return nil
        }
        while i < codes.count {
            let sub = codes[i]
            let c = sub.first ?? 0
            switch c {
            case 0: style = TermStyle()
            case 1: style.bold = true
            case 2: style.dim = true
            case 3: style.italic = true
            case 4: style.underline = sub.count < 2 || sub[1] != 0
            case 7: style.inverse = true
            case 9: style.strike = true
            case 21: style.underline = true
            case 22:
                style.bold = false
                style.dim = false
            case 23: style.italic = false
            case 24: style.underline = false
            case 27: style.inverse = false
            case 29: style.strike = false
            case 30...37: style.fg = .palette(UInt8(c - 30))
            case 38: if let col = extended(sub) { style.fg = col }
            case 39: style.fg = .default
            case 40...47: style.bg = .palette(UInt8(c - 40))
            case 48: if let col = extended(sub) { style.bg = col }
            case 49: style.bg = .default
            case 90...97: style.fg = .palette(UInt8(c - 90 + 8))
            case 100...107: style.bg = .palette(UInt8(c - 100 + 8))
            default: break
            }
            i += 1
        }
    }

    // MARK: Size

    /// A new size: lines are cut or padded (no reflow); rows that no longer
    /// fit above the cursor go to the scroll-back.
    public func resize(cols newCols: Int, rows newRows: Int) {
        let c = max(newCols, 1)
        let r = max(newRows, 1)
        guard c != cols || r != rows else { return }
        func fit(_ line: [TermCell]) -> [TermCell] {
            if line.count >= c {
                var l = Array(line.prefix(c))
                // A wide character cut in half is dropped.
                if line.count > c, line[c].continuation { l[c - 1] = .blank }
                return l
            }
            return line + Array(repeating: .blank, count: c - line.count)
        }
        cols = c
        lines = lines.map(fit)
        scrollback = scrollback.map(fit)
        if var main = savedMain {
            main.lines = main.lines.map(fit)
            savedMain = main
        }
        if r < rows {
            // Drop blank lines below the cursor first, then push the top into the scroll-back.
            var excess = rows - r
            while excess > 0, lines.count - 1 > cursorY, lines.last?.allSatisfy({ $0.text == " " || $0.text.isEmpty }) == true {
                lines.removeLast()
                excess -= 1
            }
            while lines.count > r {
                let gone = lines.removeFirst()
                if !altScreen { scrollback.append(gone) }
                cursorY -= 1
            }
            if scrollback.count > scrollbackLimit { scrollback.removeFirst(scrollback.count - scrollbackLimit) }
        } else if r > rows {
            lines.append(contentsOf: Array(repeating: Array(repeating: .blank, count: c), count: r - rows))
        }
        rows = r
        top = 0
        bottom = r - 1
        cursorX = min(max(cursorX, 0), c - 1)
        cursorY = min(max(cursorY, 0), r - 1)
        wrapPending = false
        lastPut = nil
    }

    // MARK: Reading

    private static func line(_ cells: [TermCell], cursor: Int?) -> TermLine {
        var runs: [TermLine.Run] = []
        var text = ""
        var current: TermStyle?
        // Trailing blanks in the default style are dropped (the cursor's cell is kept).
        var end = cells.count
        while end > 0, cells[end - 1].text == " ", cells[end - 1].style == .plain, cursor.map({ $0 < end - 1 }) ?? true { end -= 1 }
        for (x, cell) in cells.prefix(end).enumerated() where !cell.continuation {
            var s = cell.style
            if x == cursor { s.inverse.toggle() }
            if s != current {
                if let cur = current, !text.isEmpty { runs.append(.init(text: text, style: cur)) }
                text = ""
                current = s
            }
            text += cell.text.isEmpty ? " " : cell.text
        }
        if let cur = current, !text.isEmpty { runs.append(.init(text: text, style: cur)) }
        return TermLine(runs: runs)
    }

    /// The scroll-back then the screen, oldest first. With `cursor`, the
    /// cursor's cell is drawn inverted while the program shows it.
    public func rendered(cursor: Bool = false) -> [TermLine] {
        let back = altScreen ? [] : scrollback.map { Self.line($0, cursor: nil) }
        let screen = lines.enumerated().map { y, l in
            Self.line(l, cursor: cursor && cursorVisible && y == cursorY ? cursorX : nil)
        }
        return back + screen
    }

    /// The screen's text, one string per row, trailing blanks dropped (tests, accessibility).
    public var screenText: [String] {
        lines.map { Self.line($0, cursor: nil).text }
    }

    public var scrollbackCount: Int { scrollback.count }

    /// The style of a cell on the screen (tests).
    public func style(x: Int, y: Int) -> TermStyle {
        lines[y][x].style
    }
}
