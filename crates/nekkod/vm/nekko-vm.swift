// nekko-vm: one throwaway macOS VM for a CI runner job, on Apple's
// Virtualization.framework (docs/decisions/0022-ci-runners-vm-and-network.md).
// Built by apps/desktop/scripts/stage-daemon.mjs and staged beside nekkod, which
// is the only caller. It is the only binary that carries the
// com.apple.security.virtualization entitlement (nekko-vm.entitlements).
//
// One JSON object per stdout line.
//   clone --from <bundle> --to <bundle>        {"ok":true} | {"ok":false,"error"} (exit 1)
//   run --bundle <dir> --cpus N --memory-mb M --net-fd 3 [--seed <img>] [--cache <img>]
//                                              {"event":"started"}, then
//                                              {"event":"stopped","reason":"guest|signal|error","detail"}
//   count-vms                                  {"count":N}
//
// A bundle is a directory with config.json (keys hardwareModel and ecid as base64
// of the framework's data representations, plus macAddress), disk.img and
// nvram.bin. That is the same file layout Tart uses, so pilot images can be
// shared; no Tart code is used here.
import Darwin
import Foundation
import Virtualization

/// Writes one JSON line with the keys in the order given, as documented above.
func emit(_ pairs: KeyValuePairs<String, Any>) {
    let json = { (v: Any) in String(decoding: try! JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed, .withoutEscapingSlashes]), as: UTF8.self) }
    let line = "{" + pairs.map { json($0.key) + ":" + json($0.value) }.joined(separator: ",") + "}\n"
    FileHandle.standardOutput.write(Data(line.utf8))
}

let args = Array(CommandLine.arguments.dropFirst())

func flag(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

struct Failure: Error, CustomStringConvertible { let description: String }

// MARK: clone

/// Makes a new bundle from a base image. disk.img and nvram.bin are APFS clones
/// (clonefile), so a 50 GB image costs no space or time until the guest writes,
/// and the source is never opened for writing. The clone gets its own MAC so two
/// VMs from one image never share an address on nekkod's NAT.
func clone() -> Never {
    guard let from = flag("--from"), let to = flag("--to") else {
        emit(["ok": false, "error": "clone needs --from and --to"]); exit(1)
    }
    let fm = FileManager.default
    let names = ["config.json", "disk.img", "nvram.bin"]
    if let missing = names.first(where: { !fm.fileExists(atPath: "\(from)/\($0)") }) {
        emit(["ok": false, "error": "\(from) is not a VM bundle: no \(missing)"]); exit(1)
    }
    if fm.fileExists(atPath: to) {
        emit(["ok": false, "error": "\(to) already exists"]); exit(1)
    }
    do {
        try fm.createDirectory(atPath: to, withIntermediateDirectories: false)
        for name in ["disk.img", "nvram.bin"] where clonefile("\(from)/\(name)", "\(to)/\(name)", 0) != 0 {
            throw Failure(description: "clonefile \(name): \(String(cString: strerror(errno))) (the clone must be on the same APFS volume)")
        }
        let raw = try Data(contentsOf: URL(fileURLWithPath: "\(from)/config.json"))
        guard var config = try JSONSerialization.jsonObject(with: raw) as? [String: Any] else {
            throw Failure(description: "config.json is not a JSON object")
        }
        config["macAddress"] = VZMACAddress.randomLocallyAdministered().string
        let out = try JSONSerialization.data(withJSONObject: config, options: [.sortedKeys, .withoutEscapingSlashes])
        try out.write(to: URL(fileURLWithPath: "\(to)/config.json"), options: .atomic)
    } catch {
        try? fm.removeItem(atPath: to)
        emit(["ok": false, "error": "\(error)"]); exit(1)
    }
    emit(["ok": true]); exit(0)
}

// MARK: count-vms

/// Counts every running Virtualization.framework VM on this Mac, ours or not.
/// Apple's license allows two macOS guests per Mac, and a Linux guest's process
/// looks the same, so the count is conservative on purpose.
func countVms() -> Never {
    let size = proc_listallpids(nil, 0)
    var pids = [pid_t](repeating: 0, count: Int(max(size, 0)) + 64)
    let n = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size))
    var path = [CChar](repeating: 0, count: Int(MAXPATHLEN) * 4)
    var count = 0
    for pid in pids.prefix(Int(max(n, 0))) where pid > 0 {
        guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { continue }
        if String(cString: path).hasSuffix("/com.apple.Virtualization.VirtualMachine") { count += 1 }
    }
    emit(["count": count]); exit(0)
}

// MARK: run

/// Builds the VM from a bundle and the flags. CPU and memory come from nekkod
/// (the runner settings), never from config.json, so an image cannot ask for
/// more of the host than the user gave it.
///
/// Deliberately absent, because the guest runs untrusted CI jobs and must not
/// reach the host by any path but nekkod's filtered NAT:
/// - no directory sharing (VZSharedDirectoryConfiguration): it would expose host files;
/// - no clipboard, serial console, audio or USB: each is a host channel the job does not need;
/// - no keyboard or pointing device, and no VZVirtualMachineView: nobody drives the guest.
///
/// One display device is present (see below) only because a macOS guest does not boot without one.
func makeConfiguration(bundle: String, cpus: Int, memoryMB: UInt64, netFd: Int32) throws -> VZVirtualMachineConfiguration {
    let fm = FileManager.default
    for name in ["config.json", "disk.img", "nvram.bin"] where !fm.fileExists(atPath: "\(bundle)/\(name)") {
        throw Failure(description: "\(bundle) is not a VM bundle: no \(name)")
    }
    let raw = try Data(contentsOf: URL(fileURLWithPath: "\(bundle)/config.json"))
    guard let json = try JSONSerialization.jsonObject(with: raw) as? [String: Any] else {
        throw Failure(description: "config.json is not a JSON object")
    }
    guard let modelData = (json["hardwareModel"] as? String).flatMap({ Data(base64Encoded: $0) }),
          let model = VZMacHardwareModel(dataRepresentation: modelData) else {
        throw Failure(description: "config.json has no usable hardwareModel")
    }
    guard model.isSupported else { throw Failure(description: "this Mac cannot run the image's hardware model") }
    guard let ecidData = (json["ecid"] as? String).flatMap({ Data(base64Encoded: $0) }),
          let ecid = VZMacMachineIdentifier(dataRepresentation: ecidData) else {
        throw Failure(description: "config.json has no usable ecid")
    }
    guard let mac = (json["macAddress"] as? String).flatMap({ VZMACAddress(string: $0) }) else {
        throw Failure(description: "config.json has no usable macAddress")
    }

    let config = VZVirtualMachineConfiguration()
    let cpuRange = VZVirtualMachineConfiguration.minimumAllowedCPUCount...VZVirtualMachineConfiguration.maximumAllowedCPUCount
    guard cpuRange.contains(cpus) else { throw Failure(description: "--cpus must be in \(cpuRange)") }
    let memory = memoryMB * 1024 * 1024
    let memoryRange = VZVirtualMachineConfiguration.minimumAllowedMemorySize...VZVirtualMachineConfiguration.maximumAllowedMemorySize
    guard memoryRange.contains(memory) else {
        throw Failure(description: "--memory-mb must be in \(memoryRange.lowerBound >> 20)...\(memoryRange.upperBound >> 20)")
    }
    config.cpuCount = cpus
    config.memorySize = memory

    let platform = VZMacPlatformConfiguration()
    platform.hardwareModel = model
    platform.machineIdentifier = ecid
    platform.auxiliaryStorage = VZMacAuxiliaryStorage(contentsOf: URL(fileURLWithPath: "\(bundle)/nvram.bin"))
    config.platform = platform
    config.bootLoader = VZMacOSBootLoader()

    // The clone's own disk, read-write; the seed (the job's single-use runner
    // config) read-only, so the guest cannot alter what the host handed it; the
    // cache read-write, shared by nothing else while this VM runs.
    var disks = [(path: "\(bundle)/disk.img", readOnly: false)]
    if let seed = flag("--seed") { disks.append((seed, true)) }
    if let cache = flag("--cache") { disks.append((cache, false)) }
    config.storageDevices = try disks.map {
        let attachment = try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: $0.path), readOnly: $0.readOnly)
        return VZVirtioBlockDeviceConfiguration(attachment: attachment)
    }

    // The guest's only network: raw Ethernet frames on a datagram socket whose
    // other end is nekkod's userspace NAT, which forwards to public addresses only.
    let network = VZVirtioNetworkDeviceConfiguration()
    network.macAddress = mac
    let attachment = VZFileHandleNetworkDeviceAttachment(fileHandle: FileHandle(fileDescriptor: netFd, closeOnDealloc: false))
    attachment.maximumTransmissionUnit = 1500
    network.attachment = attachment
    config.networkDevices = [network]

    // A display device with no view and no input devices. A macOS guest does
    // not boot without a graphics device (with none it spins at boot and never
    // brings up its network). Nothing attaches a VZVirtualMachineView, so no
    // frame of the guest's screen ever reaches the host.
    let graphics = VZMacGraphicsDeviceConfiguration()
    graphics.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: 1024, heightInPixels: 768, pixelsPerInch: 72)]
    config.graphicsDevices = [graphics]

    config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
    config.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
    try config.validate()
    return config
}

var finished = false

/// Reports the stop once and exits. Exiting this process also ends the VM: the
/// framework's VM process belongs to us and goes when we go.
func finish(_ reason: String, _ detail: String, code: Int32) -> Never {
    if !finished {
        finished = true
        emit(["event": "stopped", "reason": reason, "detail": detail])
    }
    exit(code)
}

/// True while nekkod still holds the other end of the network socket. getpeername
/// neither reads nor clears anything, so it cannot steal a frame from the
/// framework, and a datagram socket gives no EOF event to wait on.
func peerConnected(_ fd: Int32) -> Bool {
    var addr = sockaddr_storage()
    var len = socklen_t(MemoryLayout<sockaddr_storage>.size)
    return withUnsafeMutablePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getpeername(fd, $0, &len) == 0 }
    }
}

final class Delegate: NSObject, VZVirtualMachineDelegate {
    var signalled = false
    func guestDidStop(_ vm: VZVirtualMachine) {
        finish(signalled ? "signal" : "guest", "the guest shut down", code: 0)
    }
    func virtualMachine(_ vm: VZVirtualMachine, didStopWithError error: Error) {
        finish("error", "\(error)", code: 1)
    }
    func virtualMachine(_ vm: VZVirtualMachine, networkDevice: VZNetworkDevice, attachmentWasDisconnectedWithError error: Error) {
        stopForLostNetwork(vm)
    }
}

/// nekkod is gone (it exited or restarted), so nobody supervises this VM any
/// more: stop it hard and exit rather than leave an orphan guest running.
func stopForLostNetwork(_ vm: VZVirtualMachine) {
    let detail = "nekkod closed the network socket"
    guard vm.canStop else { finish("error", detail, code: 1) }
    vm.stop { _ in finish("error", detail, code: 1) }
}

func run() -> Never {
    guard let bundle = flag("--bundle"), let cpus = flag("--cpus").flatMap({ Int($0) }),
          let memoryMB = flag("--memory-mb").flatMap({ UInt64($0) }), let netFd = flag("--net-fd").flatMap({ Int32($0) }) else {
        finish("error", "run needs --bundle, --cpus, --memory-mb and --net-fd", code: 1)
    }
    let config: VZVirtualMachineConfiguration
    do {
        config = try makeConfiguration(bundle: bundle, cpus: cpus, memoryMB: memoryMB, netFd: netFd)
    } catch {
        finish("error", "\(error)", code: 1)
    }
    guard peerConnected(netFd) else { finish("error", "--net-fd \(netFd) is not a connected socket", code: 1) }

    // The framework requires the VM to live on one queue; main, run by dispatchMain.
    let vm = VZVirtualMachine(configuration: config)
    let delegate = Delegate()
    vm.delegate = delegate

    // SIGTERM asks the guest to shut down cleanly, then pulls the plug after 20 s.
    signal(SIGTERM, SIG_IGN)
    let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    term.setEventHandler {
        delegate.signalled = true
        if vm.canRequestStop, (try? vm.requestStop()) != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
                vm.stop { _ in finish("signal", "the guest did not shut down within 20 s", code: 0) }
            }
        } else if vm.canStop {
            vm.stop { _ in finish("signal", "stopped before the guest was up", code: 0) }
        } else {
            finish("signal", "stopped before the VM started", code: 0)
        }
    }
    term.resume()

    let watch = DispatchSource.makeTimerSource(queue: .main)
    watch.schedule(deadline: .now() + 1, repeating: 1)
    watch.setEventHandler { if !peerConnected(netFd) { stopForLostNetwork(vm) } }
    watch.resume()

    vm.start { result in
        switch result {
        case .success: emit(["event": "started"])
        case .failure(let error): finish("error", "\(error)", code: 1)
        }
    }
    withExtendedLifetime((vm, delegate, term, watch)) { dispatchMain() }
}

switch args.first {
case "clone": clone()
case "run": run()
case "count-vms": countVms()
default:
    emit(["ok": false, "error": "usage: nekko-vm clone|run|count-vms"])
    exit(1)
}
