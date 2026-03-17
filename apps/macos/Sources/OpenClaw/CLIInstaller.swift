import Foundation

@MainActor

enum CLIInstaller {
    private struct InstallInvocation {
        let command: [String]
        let cwd: String?
        let env: [String: String]?
        let initialStatus: String
    }

    static func installedLocation() -> String? {
        self.installedLocation(
            searchPaths: CommandResolver.preferredPaths(),
            fileManager: .default)
    }

    static func installedLocation(
        searchPaths: [String],
        fileManager: FileManager) -> String?
    {
        for basePath in searchPaths {
            let candidate = URL(fileURLWithPath: basePath).appendingPathComponent("openclaw").path
            var isDirectory: ObjCBool = false

            guard fileManager.fileExists(atPath: candidate, isDirectory: &isDirectory),
                  !isDirectory.boolValue
            else {
                continue
            }

            guard fileManager.isExecutableFile(atPath: candidate) else { continue }

            return candidate
        }

        return nil
    }

    static func isInstalled() -> Bool {
        self.installedLocation() != nil
    }

    static func install(statusHandler: @escaping @MainActor @Sendable (String) async -> Void) async {
        let expectedVersion = GatewayEnvironment.expectedGatewayVersionString()
        let prefix = Self.installPrefix()
        let invocation = self.installInvocation(versionString: expectedVersion, prefix: prefix)
        await statusHandler(invocation.initialStatus)
        let response = await ShellExecutor.runDetailed(
            command: invocation.command,
            cwd: invocation.cwd,
            env: invocation.env,
            timeout: 900)

        if response.success {
            let parsed = self.parseInstallEvents(response.stdout)
            let installedVersion = parsed.last { $0.event == "done" }?.version
            let summary = installedVersion.map { "Installed openclaw \($0)." } ?? "Installed openclaw."
            await statusHandler(summary)
            return
        }

        let parsed = self.parseInstallEvents(response.stdout)
        if let error = parsed.last(where: { $0.event == "error" })?.message {
            await statusHandler("Install failed: \(error)")
            return
        }

        let detail = response.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = response.errorMessage ?? "install failed"
        await statusHandler("Install failed: \(detail.isEmpty ? fallback : detail)")
    }

    static func manualInstallCommand(versionString: String?) -> String {
        let prefix = self.installPrefix()
        if let invocation = self.localInstallInvocation(versionString: versionString, prefix: prefix) {
            let script = invocation.command.map(self.shellEscape).joined(separator: " ")
            let cwd = invocation.cwd.map(self.shellEscape) ?? self.shellEscape(FileManager.default.currentDirectoryPath)
            return "cd \(cwd) && \(script)"
        }

        let target = self.normalizedVersionTarget(versionString)
        return "npm install -g openclaw@\(target)"
    }

    private static func installPrefix() -> String {
        FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent(".openclaw")
            .path
    }

    private static func installInvocation(versionString: String?, prefix: String) -> InstallInvocation {
        self.localInstallInvocation(versionString: versionString, prefix: prefix)
            ?? self.remoteInstallInvocation(versionString: versionString, prefix: prefix)
    }

    private static func localInstallInvocation(versionString: String?, prefix: String) -> InstallInvocation? {
        let projectRoot = CommandResolver.projectRoot()
        let packageJsonPath = projectRoot.appendingPathComponent("package.json")
        let scriptPath = projectRoot.appendingPathComponent("scripts/install-local-cli.js")
        guard FileManager.default.isReadableFile(atPath: packageJsonPath.path),
              FileManager.default.isReadableFile(atPath: scriptPath.path)
        else {
            return nil
        }

        let preferredPaths = [projectRoot.appendingPathComponent("node_modules/.bin").path] + CommandResolver.preferredPaths()
        let node = CommandResolver.findExecutable(named: "node", searchPaths: preferredPaths) ?? "node"
        var command = [node, scriptPath.path, "--json", "--prefix", prefix]
        if let version = versionString?.trimmingCharacters(in: .whitespacesAndNewlines), !version.isEmpty {
            command += ["--expected-version", version]
        }

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = preferredPaths.joined(separator: ":")

        return InstallInvocation(
            command: command,
            cwd: projectRoot.path,
            env: env,
            initialStatus: "Building current checkout, packing npm tarball, and installing openclaw CLI…")
    }

    private static func remoteInstallInvocation(versionString: String?, prefix: String) -> InstallInvocation {
        let target = self.normalizedVersionTarget(versionString)
        let command = self.installScriptCommand(version: target, prefix: prefix)
        return InstallInvocation(
            command: command,
            cwd: nil,
            env: nil,
            initialStatus: "Installing openclaw CLI…")
    }

    private static func normalizedVersionTarget(_ versionString: String?) -> String {
        let trimmed = versionString?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let trimmed, !trimmed.isEmpty {
            return trimmed
        }
        return "latest"
    }

    private static func installScriptCommand(version: String, prefix: String) -> [String] {
        let escapedVersion = self.shellEscape(version)
        let escapedPrefix = self.shellEscape(prefix)
        let script = """
        curl -fsSL https://openclaw.bot/install-cli.sh | \
        bash -s -- --json --no-onboard --prefix \(escapedPrefix) --version \(escapedVersion)
        """
        return ["/bin/bash", "-lc", script]
    }

    private static func parseInstallEvents(_ output: String) -> [InstallEvent] {
        let decoder = JSONDecoder()
        let lines = output
            .split(whereSeparator: \.isNewline)
            .map { String($0) }
        var events: [InstallEvent] = []
        for line in lines {
            guard let data = line.data(using: .utf8) else { continue }
            if let event = try? decoder.decode(InstallEvent.self, from: data) {
                events.append(event)
            }
        }
        return events
    }

    private static func shellEscape(_ raw: String) -> String {
        "'" + raw.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }
}

private struct InstallEvent: Decodable {
    let event: String
    let version: String?
    let message: String?
}
