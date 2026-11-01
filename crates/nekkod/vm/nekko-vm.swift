// nekko-vm: one throwaway macOS VM for a CI runner job, on Apple's
// Virtualization.framework (docs/decisions/0022-ci-runners-vm-and-network.md).
// Built by apps/desktop/scripts/stage-daemon.mjs and staged beside nekkod, which
// is the only caller. It is the only binary that carries the
// com.apple.security.virtualization entitlement (nekko-vm.entitlements).
//
// One JSON object per stdout line.
//   clone --from <bundle> --to <bundle>        {"ok":true} | {"ok":false,"error"} (exit 1)
//   run --bundle <dir> --cpus N --memory-mb M --net-fd 3 [--seed <img>] [--cache <img>]
//       [--first-boot-user U --first-boot-password-file F]
//                                              {"event":"started"}, then
//                                              {"event":"stopped","reason":"guest|signal|error","detail"}
//   restore-image                              {"ok":true,"url","build","version"} | {"ok":false,"error"} (exit 1)
//   install --ipsw <file> --bundle <dir> --disk-gb N
//                                              {"progress":0.5} every 5 s, then {"ok":true} | {"ok":false,"error"} (exit 1)
//   count-vms                                  {"count":N}
//   egress                                     {"physical":{"name","index"}|null,"vpnCarriesDefault",
//                                               "expensive","constrained"} now and on every change
//   host                                       {"thermal":"nominal|fair|serious|critical","lowPowerMode",
//                                               "memoryPressure":"normal|warning|critical"} now and on every change
//
// A bundle is a directory with config.json (keys hardwareModel and ecid as base64
// of the framework's data representations, plus macAddress), disk.img and
// nvram.bin. That is the same file layout Tart uses, so pilot images can be
// shared; no Tart code is used here.
import Darwin
import Foundation
import Network
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
    // mkdir is the existence check: no gap between checking and creating, so
    // the catch below only ever removes a folder this run created.
    if mkdir(to, 0o755) != 0 {
        let e = errno
        emit(["ok": false, "error": e == EEXIST ? "\(to) already exists" : "cannot create \(to): \(String(cString: strerror(e)))"])
        exit(1)
    }
    do {
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

// MARK: egress

/// Streams the interface job traffic leaves by, for nekkod's NAT to bind every
/// host socket to (IP_BOUND_IF), so no VPN route, split or full tunnel, ever
/// carries it. `physical` comes from a monitor that prohibits `.other`
/// (tunnels): its first available wifi, wired or cellular interface, or null.
/// `vpnCarriesDefault`: the default path leads with a tunnel (a full-tunnel
/// VPN or an exit node), which pauses the runner unless the user allows jobs
/// out directly. Runs until nekkod goes away.
func egress() -> Never {
    let queue = DispatchQueue(label: "egress")
    let physical = NWPathMonitor(prohibitedInterfaceTypes: [.other])
    let all = NWPathMonitor()
    var physicalPath: NWPath?
    var defaultPath: NWPath?
    var last = ""
    func report() {
        guard let p = physicalPath, let d = defaultPath else { return }
        let nic = p.availableInterfaces.first { [.wifi, .wiredEthernet, .cellular].contains($0.type) }
        let pairs: KeyValuePairs<String, Any> = [
            "physical": nic.map { ["name": $0.name, "index": $0.index] as [String: Any] } ?? NSNull(),
            "vpnCarriesDefault": d.availableInterfaces.first?.type == .other,
            "expensive": p.isExpensive,
            "constrained": p.isConstrained,
        ]
        let line = pairs.map { "\($0.key)=\($0.value)" }.joined()
        if line != last { last = line; emit(pairs) }
    }
    physical.pathUpdateHandler = { physicalPath = $0; report() }
    all.pathUpdateHandler = { defaultPath = $0; report() }
    physical.start(queue: queue)
    all.start(queue: queue)
    // Reparented means nekkod is gone; nothing else would end this process.
    let parent = getppid()
    let watch = DispatchSource.makeTimerSource(queue: queue)
    watch.schedule(deadline: .now() + 1, repeating: 1)
    watch.setEventHandler { if getppid() != parent { exit(0) } }
    watch.resume()
    withExtendedLifetime((physical, all, watch)) { dispatchMain() }
}

// MARK: host

/// Streams the Mac's thermal state, Low Power Mode and memory pressure for the
/// runner gates: ProcessInfo and its change notifications, a memory pressure
/// dispatch source for changes, and kern.memorystatus_vm_pressure_level
/// (1 normal, 2 warning, 4 critical) for the current level. Each is also
/// re-read every second, so a missed notification costs at most a second.
/// Runs until nekkod goes away.
func host() -> Never {
    let queue = DispatchQueue(label: "host")
    var last = ""
    func pressure() -> String {
        var level: Int32 = 0
        var size = MemoryLayout<Int32>.size
        // Unreadable or unknown: exit, so nekkod treats the host state as unknown (holds new VMs only).
        guard sysctlbyname("kern.memorystatus_vm_pressure_level", &level, &size, nil, 0) == 0 else { exit(1) }
        switch level {
        case 1: return "normal"
        case 2: return "warning"
        case 4: return "critical"
        default: exit(1)
        }
    }
    func report() {
        let thermal: String
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: thermal = "nominal"
        case .fair: thermal = "fair"
        case .serious: thermal = "serious"
        case .critical: thermal = "critical"
        // Unknown: exit, so nekkod treats the host state as unknown (holds new VMs only).
        @unknown default: exit(1)
        }
        let pairs: KeyValuePairs<String, Any> = [
            "thermal": thermal,
            "lowPowerMode": ProcessInfo.processInfo.isLowPowerModeEnabled,
            "memoryPressure": pressure(),
        ]
        let line = pairs.map { "\($0.key)=\($0.value)" }.joined()
        if line != last { last = line; emit(pairs) }
    }
    let ops = OperationQueue()
    ops.underlyingQueue = queue
    let names = [ProcessInfo.thermalStateDidChangeNotification, Notification.Name.NSProcessInfoPowerStateDidChange]
    let observers = names.map { NotificationCenter.default.addObserver(forName: $0, object: nil, queue: ops) { _ in report() } }
    let memory = DispatchSource.makeMemoryPressureSource(eventMask: [.normal, .warning, .critical], queue: queue)
    memory.setEventHandler { report() }
    memory.resume()
    queue.async { report() }
    // Reparented means nekkod is gone; nothing else would end this process.
    let parent = getppid()
    let watch = DispatchSource.makeTimerSource(queue: queue)
    watch.schedule(deadline: .now() + 1, repeating: 1)
    watch.setEventHandler { if getppid() != parent { exit(0) }; report() }
    watch.resume()
    withExtendedLifetime((observers, memory, watch)) { dispatchMain() }
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
func makeConfiguration(bundle: String, cpus: Int, memoryMB: UInt64, netFd: Int32?) throws -> VZVirtualMachineConfiguration {
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
    // `install` has none: the installer needs no network.
    if let netFd {
        let network = VZVirtioNetworkDeviceConfiguration()
        network.macAddress = mac
        let attachment = VZFileHandleNetworkDeviceAttachment(fileHandle: FileHandle(fileDescriptor: netFd, closeOnDealloc: false))
        attachment.maximumTransmissionUnit = 1500
        network.attachment = attachment
        config.networkDevices = [network]
    }

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
/// What `install` must hold until it exits: dropping the VM, installer or timer ends the install.
var keep: [Any] = []

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
    // Read and deleted before anything can fail, so the password never outlives this call.
    var firstBoot: (user: String, password: String)?
    if let user = flag("--first-boot-user") {
        guard let file = flag("--first-boot-password-file"), let password = try? String(contentsOfFile: file, encoding: .utf8) else {
            finish("error", "--first-boot-user needs a readable --first-boot-password-file", code: 1)
        }
        unlink(file)
        firstBoot = (user, password.trimmingCharacters(in: .whitespacesAndNewlines))
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

    if let firstBoot {
        startWithFirstBoot(vm, user: firstBoot.user, password: firstBoot.password)
    } else {
        vm.start { result in
            switch result {
            case .success: emit(["event": "started"])
            case .failure(let error): finish("error", "\(error)", code: 1)
            }
        }
    }
    withExtendedLifetime((vm, delegate, term, watch)) { dispatchMain() }
}

/// An image build's first boot, with no window and no Setup Assistant: creates
/// the admin, logs it in automatically and turns Remote Login on. Job VMs never
/// reach this (decision 0038). The framework reads these options only on a macOS 27
/// host and guest. The compiler check is the macOS 27 SDK, so an older SDK still builds.
func startWithFirstBoot(_ vm: VZVirtualMachine, user: String, password: String) {
    #if compiler(>=6.4)
    if #available(macOS 27, *) {
        do {
            let provisioning = VZMacGuestProvisioningOptions()
            provisioning.fullName = "Nekko Build"
            provisioning.username = user
            provisioning.password = password
            provisioning.logsInAutomatically = true
            provisioning.enablesRemoteLogin = true
            let options = VZMacOSVirtualMachineStartOptions()
            try options.setGuestProvisioning(provisioning)
            vm.start(options: options) { error in
                if let error { finish("error", "\(error)", code: 1) }
                emit(["event": "started"])
            }
        } catch {
            finish("error", "\(error)", code: 1)
        }
        return
    }
    #endif
    finish("error", "Update this Mac to macOS 27 to set it up here.", code: 1)
}

// MARK: restore-image

/// Apple's newest restore image for this Mac. Here, not in nekkod, because the
/// catalog call fails without the virtualization entitlement.
func restoreImage() -> Never {
    VZMacOSRestoreImage.fetchLatestSupported { result in
        switch result {
        case .success(let image):
            let v = image.operatingSystemVersion
            emit([
                "ok": true, "url": image.url.absoluteString, "build": image.buildVersion,
                "version": "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)",
            ])
            exit(0)
        case .failure(let error):
            emit(["ok": false, "error": "\(error)"])
            exit(1)
        }
    }
    dispatchMain()
}

// MARK: install

/// Makes a new bundle from an Apple restore image with VZMacOSInstaller: a sparse
/// disk, fresh identifiers, and a headless install with no network. The bundle
/// must not exist; a failed install leaves its folder for nekkod to delete.
func install() -> Never {
    guard let ipsw = flag("--ipsw"), let bundle = flag("--bundle"), let gb = flag("--disk-gb").flatMap({ UInt64($0) }) else {
        emit(["ok": false, "error": "install needs --ipsw, --bundle and --disk-gb"]); exit(1)
    }
    let url = URL(fileURLWithPath: ipsw)
    let parent = getppid()
    VZMacOSRestoreImage.load(from: url) { loaded in
        DispatchQueue.main.async {
            do {
                let image = try loaded.get()
                guard let req = image.mostFeaturefulSupportedConfiguration, req.hardwareModel.isSupported else {
                    throw Failure(description: "this Mac cannot install this restore image")
                }
                guard mkdir(bundle, 0o755) == 0 else {
                    throw Failure(description: "cannot create \(bundle): \(String(cString: strerror(errno)))")
                }
                let fd = open("\(bundle)/disk.img", O_RDWR | O_CREAT | O_EXCL, 0o644)
                guard fd >= 0, ftruncate(fd, off_t(gb * 1_000_000_000)) == 0 else {
                    throw Failure(description: "cannot create disk.img: \(String(cString: strerror(errno)))")
                }
                close(fd)
                _ = try VZMacAuxiliaryStorage(creatingStorageAt: URL(fileURLWithPath: "\(bundle)/nvram.bin"), hardwareModel: req.hardwareModel, options: [])
                let json: [String: Any] = [
                    "version": 1, "os": "darwin", "arch": "arm64", "diskFormat": "raw",
                    "cpuCount": 4, "cpuCountMin": req.minimumSupportedCPUCount,
                    "memorySize": 8_589_934_592, "memorySizeMin": req.minimumSupportedMemorySize,
                    "display": ["width": 1024, "height": 768],
                    "macAddress": VZMACAddress.randomLocallyAdministered().string,
                    "hardwareModel": req.hardwareModel.dataRepresentation.base64EncodedString(),
                    "ecid": VZMacMachineIdentifier().dataRepresentation.base64EncodedString(),
                ]
                try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys, .withoutEscapingSlashes])
                    .write(to: URL(fileURLWithPath: "\(bundle)/config.json"))
                let config = try makeConfiguration(bundle: bundle, cpus: 4, memoryMB: 8192, netFd: nil)
                let vm = VZVirtualMachine(configuration: config)
                let installer = VZMacOSInstaller(virtualMachine: vm, restoringFromImageAt: url)
                let tick = DispatchSource.makeTimerSource(queue: .main)
                tick.schedule(deadline: .now() + 5, repeating: 5)
                tick.setEventHandler { emit(["progress": installer.progress.fractionCompleted]) }
                tick.resume()
                // Reparented means nekkod is gone; nothing else would end this process.
                let watch = DispatchSource.makeTimerSource(queue: .main)
                watch.schedule(deadline: .now() + 1, repeating: 1)
                watch.setEventHandler { if getppid() != parent { exit(1) } }
                watch.resume()
                keep = [vm, installer, tick, watch]
                installer.install { result in
                    switch result {
                    case .success: emit(["ok": true]); exit(0)
                    case .failure(let error): emit(["ok": false, "error": "\(error)"]); exit(1)
                    }
                }
            } catch {
                emit(["ok": false, "error": "\(error)"]); exit(1)
            }
        }
    }
    dispatchMain()
}

switch args.first {
case "clone": clone()
case "run": run()
case "restore-image": restoreImage()
case "install": install()
case "count-vms": countVms()
case "egress": egress()
case "host": host()
default:
    emit(["ok": false, "error": "usage: nekko-vm clone|run|restore-image|install|count-vms|egress|host"])
    exit(1)
}
