// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProviderDriverKind } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import {
  createProviderVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  resolvePackageManagedProviderMaintenance,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "./providerMaintenance.ts";
import { installFakeMise } from "./testUtils/fakeMise.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const claudeUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: CLAUDE,
  npmPackageName: "@anthropic-ai/claude-code",
  nativeUpdate: null,
});

// Shims, wrappers, and the fake mise are POSIX scripts and symlinks.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

/** A sandbox whose paths contain spaces, as a user's home or data dir may. */
function makeSandbox() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), "t3 mise "));
  return { root, dataDir: NodePath.join(root, "mise data") };
}

function writeScript(path: string, content: string) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, content);
  NodeFS.chmodSync(path, 0o755);
}

/** `<data>/installs/<dir>/<version>/<bin>` plus mise's `latest` link to it. */
function installTool(dataDir: string, directory: string, version: string, bin: string) {
  const toolDir = NodePath.join(dataDir, "installs", directory);
  writeScript(NodePath.join(toolDir, version, bin), "#!/bin/sh\n");
  NodeFS.symlinkSync(version, NodePath.join(toolDir, "latest"));
  return {
    installPath: NodePath.join(toolDir, version),
    latestBin: NodePath.join(toolDir, "latest", bin),
  };
}

function miseListing(
  tool: string,
  installPath: string,
  version: string,
  options?: { readonly active?: boolean },
) {
  return { [tool]: [{ version, install_path: installPath, active: options?.active ?? true }] };
}

function miseOutdated(tool: string, latest: string) {
  return { [tool]: { latest } };
}

it.layer(NodeServices.layer)("mise provider ownership", (it) => {
  it.effect.each([
    {
      name: "double-quoted alias",
      execLine: 'exec mise x "claude" -- "claude" "$@"',
      tool: "claude",
    },
    {
      name: "single-quoted npm backend",
      execLine: "exec mise x 'npm:@anthropic-ai/claude-code' -- 'claude' \"$@\"",
      tool: "npm:@anthropic-ai/claude-code",
    },
    {
      name: "bare words through mise exec",
      execLine: 'exec mise exec claude -- claude "$@"',
      tool: "claude",
    },
  ])(
    "upgrades the tool an Omarchy wrapper runs: $name",
    ({ execLine, tool }) =>
      Effect.gen(function* () {
        const { root, dataDir } = makeSandbox();
        const claude = installTool(dataDir, "claude", "2.1.0", "bin/claude");
        const fake = installFakeMise(NodePath.join(root, "mise bin", "mise"), {
          which: { claude: claude.latestBin },
          ls: miseListing(tool, claude.installPath, "2.1.0"),
          outdated: miseOutdated(tool, "2.1.5"),
        });
        const wrapperDir = NodePath.join(root, ".local", "bin");
        writeScript(
          NodePath.join(wrapperDir, "claude"),
          [
            "#!/bin/bash",
            // The bug in #9225 read the first mise command anywhere in the file.
            '# exec mise x "other-tool" -- "other-tool" "$@"',
            "export MISE_MINIMUM_RELEASE_AGE=0",
            'mise use -g --quiet "other-tool" || exit 1',
            execLine,
            "",
          ].join("\n"),
        );
        const env = {
          PATH: [wrapperDir, NodePath.dirname(fake.misePath)].join(NodePath.delimiter),
          HOME: root,
          MISE_DATA_DIR: dataDir,
        };

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath: "claude",
          env,
        });

        expect(capabilities.update).toEqual({
          command: `'${fake.misePath}' upgrade ${tool}`,
          executable: fake.misePath,
          args: ["upgrade", tool],
          lockKey: "mise",
          env,
        });
        expect(capabilities.latestVersion).toBe("2.1.5");
        expect(fake.calls()).toEqual([
          { dataDir, args: "which claude" },
          { dataDir, args: "ls --installed --json" },
          { dataDir, args: `outdated --json ${tool}` },
        ]);

        // The runner spawns the action over the server's environment.
        const update = capabilities.update!;
        const result = NodeChildProcess.spawnSync(update.executable, update.args, {
          env: { ...process.env, ...update.env },
        });
        expect(result.status).toBe(0);
        expect(fake.calls().at(-1)).toEqual({ dataDir, args: `upgrade ${tool}` });
      }),
    { skip: windowsHost },
  );

  it.effect.skipIf(windowsHost)(
    "follows a wrapper that execs a mise shim through a variable to the mise it links to",
    () =>
      Effect.gen(function* () {
        const { root, dataDir } = makeSandbox();
        const claude = installTool(dataDir, "claude", "2.1.0", "bin/claude");
        // Not on PATH: only the shim's link can lead resolution to this mise.
        const fake = installFakeMise(NodePath.join(root, "opt", "mise"), {
          which: { claude: claude.latestBin },
          ls: miseListing("claude", claude.installPath, "2.1.0"),
          outdated: {},
        });
        NodeFS.mkdirSync(NodePath.join(dataDir, "shims"), { recursive: true });
        NodeFS.symlinkSync(fake.misePath, NodePath.join(dataDir, "shims", "claude"));
        const binaryPath = NodePath.join(root, ".local", "bin", "claude");
        writeScript(
          binaryPath,
          [
            "#!/bin/bash",
            'shim="$HOME/mise data/shims/claude"',
            "if [[ ! -x $shim ]]; then",
            '  flock "$HOME/.config/mise/.wrapper.lock" mise use -g "claude" >/dev/null || exit 1',
            "fi",
            'exec "$shim" "$@"',
            "",
          ].join("\n"),
        );

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath,
          env: { PATH: "", HOME: root },
        });

        expect(capabilities.update).toMatchObject({
          executable: fake.misePath,
          args: ["upgrade", "claude"],
        });
        // Up to date within its request: the installed version is the target.
        expect(capabilities.latestVersion).toBe("2.1.0");
      }),
  );

  it.effect.skipIf(windowsHost)(
    "treats an exact pin as current instead of advertising an unreachable update",
    () =>
      Effect.gen(function* () {
        const { root, dataDir } = makeSandbox();
        const tool = "npm:@anthropic-ai/claude-code";
        const claude = installTool(
          dataDir,
          "npm-anthropic-ai-claude-code",
          "2.1.0",
          "lib/node_modules/@anthropic-ai/claude-code/cli.js",
        );
        // `mise outdated` omits a tool pinned to its installed version.
        const fake = installFakeMise(NodePath.join(root, "bin", "mise"), {
          ls: miseListing(tool, claude.installPath, "2.1.0"),
          outdated: {},
        });
        const binaryPath = NodePath.join(root, "links", "claude");
        NodeFS.mkdirSync(NodePath.dirname(binaryPath));
        NodeFS.symlinkSync(claude.latestBin, binaryPath);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath,
          env: { PATH: NodePath.dirname(fake.misePath), MISE_DATA_DIR: dataDir },
        });

        expect(capabilities.update?.args).toEqual(["upgrade", tool]);
        expect(
          createProviderVersionAdvisory({
            driver: CLAUDE,
            currentVersion: "2.1.0",
            latestVersion: capabilities.latestVersion ?? null,
            maintenanceCapabilities: capabilities,
          }),
        ).toMatchObject({ status: "current", canUpdate: true, canInstallVersion: false });
      }),
  );

  it.effect.skipIf(windowsHost)(
    "keeps npm updates for a global that mise's Node runs through a shim",
    () =>
      Effect.gen(function* () {
        const { root, dataDir } = makeSandbox();
        const node = NodePath.join(dataDir, "installs", "node", "24.0.0");
        const entry = NodePath.join(
          node,
          "lib",
          "node_modules",
          "@anthropic-ai",
          "claude-code",
          "cli.js",
        );
        writeScript(entry, "#!/bin/sh\n");
        NodeFS.mkdirSync(NodePath.join(node, "bin"));
        NodeFS.symlinkSync(entry, NodePath.join(node, "bin", "claude"));
        const fake = installFakeMise(NodePath.join(root, "bin", "mise"), {
          which: { claude: NodePath.join(node, "bin", "claude") },
          ls: miseListing("node", node, "24.0.0"),
        });
        NodeFS.mkdirSync(NodePath.join(dataDir, "shims"), { recursive: true });
        NodeFS.symlinkSync(fake.misePath, NodePath.join(dataDir, "shims", "claude"));

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath: "claude",
          env: { PATH: NodePath.join(dataDir, "shims"), MISE_DATA_DIR: dataDir },
        });

        expect(capabilities.update).toMatchObject({
          executable: "npm",
          args: expect.arrayContaining(["--prefix", node, "@anthropic-ai/claude-code@latest"]),
        });
        expect(fake.calls().map((call) => call.args)).toEqual([
          "which claude",
          "ls --installed --json",
        ]);
      }),
  );

  it.effect.each([
    {
      name: "a version directory `mise activate` put on PATH",
      launch: "version-directory",
      active: true,
    },
    { name: "a version mise's config does not select", launch: "latest-link", active: false },
  ] as const)(
    "stays manual-only for $name",
    ({ launch, active }) =>
      Effect.gen(function* () {
        const { root, dataDir } = makeSandbox();
        const claude = installTool(dataDir, "claude", "2.1.0", "bin/claude");
        const fake = installFakeMise(NodePath.join(root, "bin", "mise"), {
          ls: miseListing("claude", claude.installPath, "2.1.0", { active }),
          outdated: miseOutdated("claude", "2.1.5"),
        });
        const binDir =
          launch === "version-directory"
            ? NodePath.join(claude.installPath, "bin")
            : NodePath.dirname(claude.latestBin);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath: "claude",
          env: { PATH: [binDir, NodePath.dirname(fake.misePath)].join(NodePath.delimiter) },
        });

        expect(capabilities.update).toBeNull();
        expect(fake.calls().map((call) => call.args)).toEqual(["ls --installed --json"]);
      }),
    { skip: windowsHost },
  );

  it.effect.each([
    { name: "mise has no tool for the shim", which: false, ls: {} },
    { name: "`mise ls` prints something unexpected", which: true, ls: "not json" },
    { name: "the bin is outside every install", which: true, ls: {} },
  ])(
    "stays manual-only when $name",
    ({ which, ls }) =>
      Effect.gen(function* () {
        const { root, dataDir } = makeSandbox();
        const claude = installTool(dataDir, "claude", "2.1.0", "bin/claude");
        const fake = installFakeMise(NodePath.join(root, "bin", "mise"), {
          ...(which ? { which: { claude: claude.latestBin } } : {}),
          ls,
        });
        const shim = NodePath.join(dataDir, "shims", "claude");
        NodeFS.mkdirSync(NodePath.dirname(shim), { recursive: true });
        NodeFS.symlinkSync(fake.misePath, shim);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath: shim,
          env: { PATH: "" },
        });

        expect(capabilities.update).toBeNull();
      }),
    { skip: windowsHost },
  );

  it.effect.skipIf(windowsHost)(
    "stays manual-only when a wrapper runs a different tool than mise resolves",
    () =>
      Effect.gen(function* () {
        const { root, dataDir } = makeSandbox();
        const claude = installTool(dataDir, "claude", "2.1.0", "bin/claude");
        const fake = installFakeMise(NodePath.join(root, "bin", "mise"), {
          which: { claude: claude.latestBin },
          ls: miseListing("claude", claude.installPath, "2.1.0"),
        });
        const wrapper = NodePath.join(root, "wrapper", "claude");
        writeScript(wrapper, '#!/bin/sh\nexec mise x "npm:other" -- "claude" "$@"\n');

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath: wrapper,
          env: { PATH: NodePath.dirname(fake.misePath) },
        });

        expect(capabilities.update).toBeNull();
      }),
  );

  it.effect.each([
    {
      name: "only a commented-out line mentions mise",
      script: '#!/bin/sh\n# exec mise x "claude" -- "claude" "$@"\nexec /bin/sh "$@"\n',
    },
    {
      name: "the wrapper pins a version",
      script: '#!/bin/sh\nexec mise x "claude@2.0.0" -- "claude" "$@"\n',
    },
    {
      name: "mise runs a script rather than the tool's own binary",
      script: '#!/bin/sh\nexec mise x node -- node "$HOME/cli.js" "$@"\n',
    },
    {
      name: "the exec line uses shell features",
      script: '#!/bin/sh\nexec mise x "$(pick-tool)" -- claude "$@"\n',
    },
  ])(
    "never runs mise when $name",
    ({ script }) =>
      Effect.gen(function* () {
        const { root } = makeSandbox();
        const fake = installFakeMise(NodePath.join(root, "bin", "mise"), {});
        const wrapper = NodePath.join(root, "wrapper", "claude");
        writeScript(wrapper, script);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath: wrapper,
          env: { PATH: NodePath.dirname(fake.misePath), HOME: root },
        });

        expect(capabilities.update).toBeNull();
        expect(fake.calls()).toEqual([]);
      }),
    { skip: windowsHost },
  );

  it.effect.skipIf(windowsHost)("leaves installs mise does not report to other installers", () =>
    Effect.gen(function* () {
      const { root } = makeSandbox();
      // asdf shares mise's `installs/<tool>/<version>` layout.
      const prefix = NodePath.join(root, ".asdf", "installs", "nodejs", "24.0.0");
      const entry = NodePath.join(
        prefix,
        "lib",
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "cli.js",
      );
      writeScript(entry, "#!/bin/sh\n");
      const fake = installFakeMise(NodePath.join(root, "bin", "mise"), { ls: {} });

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
        binaryPath: entry,
        env: { PATH: NodePath.dirname(fake.misePath) },
      });

      expect(capabilities.update).toMatchObject({
        executable: "npm",
        args: expect.arrayContaining(["--prefix", prefix]),
      });
    }),
  );

  it.effect.skipIf(windowsHost)("recognizes a Windows shim beside mise's installs", () =>
    Effect.gen(function* () {
      const { root, dataDir } = makeSandbox();
      const claude = installTool(dataDir, "claude", "2.1.0", "bin/claude.exe");
      const fake = installFakeMise(NodePath.join(root, "bin", "mise"), {
        which: { claude: claude.latestBin },
        ls: miseListing("claude", claude.installPath, "2.1.0"),
        outdated: miseOutdated("claude", "2.1.5"),
      });
      const shim = NodePath.join(dataDir, "shims", "claude.cmd");
      writeScript(shim, "@echo off\r\n");
      const env = { PATH: NodePath.dirname(fake.misePath) };

      const capabilities = yield* resolvePackageManagedProviderMaintenance(
        { provider: CLAUDE, npmPackageName: "@anthropic-ai/claude-code", nativeUpdate: null },
        {
          binaryPath: "claude",
          resolvedCommandPath: shim,
          realCommandPath: shim,
          env,
          platform: "win32",
        },
      );

      expect(capabilities.update).toMatchObject({
        executable: fake.misePath,
        args: ["upgrade", "claude"],
      });
      expect(capabilities.latestVersion).toBe("2.1.5");
    }),
  );
});
