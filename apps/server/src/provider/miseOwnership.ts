import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { runInstallerProbe } from "./installerProbe.ts";
import type { ProviderMaintenanceResolutionContext } from "./providerMaintenance.ts";

const MISE_PROBE_TIMEOUT = Duration.seconds(10);
// `outdated` asks each backend's registry for new versions.
const MISE_OUTDATED_TIMEOUT = Duration.seconds(30);
// `ls` prints every installed version of every tool.
const MISE_PROBE_MAX_BYTES = 4 * 1_024 * 1_024;
const WRAPPER_SCRIPT_MAX_BYTES = 8_192;

export type MiseOwnership =
  /** Nothing ties the executable to mise; the other installers decide. */
  | { readonly kind: "unrelated" }
  /** Mise's Node runs a package that its own npm installed globally; npm owns it. */
  | {
      readonly kind: "npm-global";
      readonly resolvedCommandPath: string;
      readonly realCommandPath: string;
    }
  /** Mise is involved, but `mise upgrade` cannot be shown to reach the executable. */
  | { readonly kind: "uncertain"; readonly reason: string }
  | {
      readonly kind: "tool";
      /** The mise that resolved ownership; the upgrade must run the same one. */
      readonly executable: string;
      /** The tool as mise's config names it, alias or backend spec, for `mise upgrade`. */
      readonly tool: string;
      /** Newest version `mise upgrade` installs within the configured request. */
      readonly latestVersion: string | null;
    };

/** How the provider executable reaches mise, read from the filesystem alone. */
type MiseLaunch =
  | { readonly kind: "none" }
  /** The executable is a file inside a tool's install directory. */
  | { readonly kind: "install-tree"; readonly launchPath: string; readonly realPath: string }
  /** A mise shim or `mise exec` picks the binary named `bin` at run time. */
  | {
      readonly kind: "bin";
      readonly bin: string;
      /** The mise binary the launcher runs, when it names one; otherwise mise on PATH. */
      readonly executable: string | null;
      /** The tool spec a `mise exec` wrapper requests. */
      readonly spec: string | null;
    };

const UNRELATED: MiseOwnership = { kind: "unrelated" };
const NO_LAUNCH: MiseLaunch = { kind: "none" };

/**
 * Ask mise which tool owns the provider executable. Probes run with the
 * provider's environment (`MISE_DATA_DIR`, `MISE_CONFIG_DIR`, PATH) and the
 * server's cwd, like the provider's own version probe, so they see the
 * installation and config the provider runs with. Only paths that already
 * point at mise start a probe.
 */
export const resolveMiseOwnership = Effect.fn("resolveMiseOwnership")(function* (
  context: ProviderMaintenanceResolutionContext,
) {
  const launch = yield* findMiseLaunch(context);
  switch (launch.kind) {
    case "none":
      return UNRELATED;
    case "install-tree": {
      // Unless mise confirms it, an `installs/` path is only a name (asdf
      // shares the layout), so the path-based installers keep deciding.
      const executable = yield* findMiseOnPath(context.env);
      if (!executable) return UNRELATED;
      const owner = yield* findOwningTool({
        executable,
        env: context.env,
        platform: context.platform,
        launchPath: launch.launchPath,
        binPath: launch.launchPath,
        realBinPath: launch.realPath,
      });
      return owner ?? UNRELATED;
    }
    case "bin": {
      const executable = launch.executable ?? (yield* findMiseOnPath(context.env));
      if (!executable) {
        return uncertain(`\`${launch.bin}\` runs through mise, but no mise executable is on PATH.`);
      }
      const requested = launch.spec === null ? null : splitToolSpec(launch.spec);
      if (requested?.version) {
        return uncertain(
          `The wrapper runs ${launch.spec}, a fixed version that \`mise upgrade\` does not move.`,
        );
      }
      const binPath = (yield* runInstallerProbe({
        executable,
        args: ["which", launch.bin],
        env: context.env,
        timeout: MISE_PROBE_TIMEOUT,
        maxBytes: MISE_PROBE_MAX_BYTES,
      }))?.trim();
      if (!binPath) {
        return uncertain(`mise has no active tool that provides \`${launch.bin}\`.`);
      }
      const fileSystem = yield* FileSystem.FileSystem;
      const realBinPath = yield* fileSystem
        .realPath(binPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (!realBinPath) {
        return uncertain(`mise resolves \`${launch.bin}\` to ${binPath}, which does not exist.`);
      }
      const owner = yield* findOwningTool({
        executable,
        env: context.env,
        platform: context.platform,
        launchPath: context.resolvedCommandPath,
        binPath,
        realBinPath,
      });
      if (!owner) {
        return uncertain(
          `mise could not attribute \`${launch.bin}\` (${binPath}) to an installed tool.`,
        );
      }
      if (requested && owner.kind === "tool" && owner.tool !== requested.tool) {
        return uncertain(
          `The wrapper runs ${requested.tool}, but mise resolves \`${launch.bin}\` from ${owner.tool}.`,
        );
      }
      return owner;
    }
  }
});

function uncertain(reason: string): MiseOwnership {
  return { kind: "uncertain", reason };
}

/**
 * Recognize the ways a mise-managed provider shows up: a shim (on POSIX a
 * symlink to the mise binary, which dispatches on the name it was run as), a
 * path inside a tool's install directory, or a launcher script that execs a
 * shim, an install path, or `mise exec`. Omarchy writes such launchers to
 * `~/.local/bin/<tool>`.
 */
const findMiseLaunch = Effect.fn("findMiseLaunch")(function* (
  context: ProviderMaintenanceResolutionContext,
) {
  const shim = yield* readMiseShim({
    launchPath: context.resolvedCommandPath,
    realPath: context.realCommandPath,
    platform: context.platform,
  });
  if (shim) return shim;
  if (isInsideInstallTree(context.realCommandPath)) {
    return {
      kind: "install-tree",
      launchPath: context.resolvedCommandPath,
      realPath: context.realCommandPath,
    } satisfies MiseLaunch;
  }

  const argv = yield* readWrapperExec(context.realCommandPath, context.env);
  if (!argv) return NO_LAUNCH;
  const path = yield* Path.Path;
  const miseExec = readMiseExec(argv, path);
  if (miseExec) return miseExec;
  const target = argv[0]!;
  if (!path.isAbsolute(target)) return NO_LAUNCH;
  const fileSystem = yield* FileSystem.FileSystem;
  const realTarget = yield* fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => null));
  if (!realTarget) return NO_LAUNCH;
  const targetShim = yield* readMiseShim({
    launchPath: target,
    realPath: realTarget,
    platform: context.platform,
  });
  if (targetShim) return targetShim;
  return isInsideInstallTree(realTarget)
    ? ({ kind: "install-tree", launchPath: target, realPath: realTarget } satisfies MiseLaunch)
    : NO_LAUNCH;
});

/**
 * POSIX shims are symlinks to the mise binary. Windows shims are `.cmd`
 * files or copies of `mise-shim.exe` in `<data>/shims`, next to `installs`.
 */
const readMiseShim = Effect.fn("readMiseShim")(function* (input: {
  readonly launchPath: string;
  readonly realPath: string;
  readonly platform: NodeJS.Platform;
}) {
  const path = yield* Path.Path;
  const bin = commandName(input.launchPath, path);
  if (bin.toLowerCase() === "mise") return null;
  const realName = commandName(input.realPath, path).toLowerCase();
  if (realName === "mise" || realName === "mise-shim") {
    return {
      kind: "bin",
      bin,
      executable: realName === "mise" ? input.realPath : null,
      spec: null,
    } satisfies MiseLaunch;
  }
  if (input.platform !== "win32") return null;
  const shimDir = path.dirname(input.launchPath);
  if (path.basename(shimDir).toLowerCase() !== "shims") return null;
  const fileSystem = yield* FileSystem.FileSystem;
  const hasInstalls = yield* fileSystem
    .exists(path.join(path.dirname(shimDir), "installs"))
    .pipe(Effect.orElseSucceed(() => false));
  return hasInstalls
    ? ({ kind: "bin", bin, executable: null, spec: null } satisfies MiseLaunch)
    : null;
});

function commandName(commandPath: string, path: Path.Path): string {
  return path.basename(commandPath).replace(/\.(?:exe|cmd|bat|ps1)$/i, "");
}

function isInsideInstallTree(realPath: string): boolean {
  return realPath.replaceAll("\\", "/").includes("/installs/");
}

/**
 * The argv of a small launcher script's single `exec` line, with `$HOME`,
 * `~`, and variables the script assigned expanded and a trailing `"$@"`
 * dropped. A launcher with no `exec`, several, or one that is not a plain
 * command yields null.
 */
const readWrapperExec = Effect.fn("readWrapperExec")(function* (
  scriptPath: string,
  env: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(scriptPath).pipe(Effect.orElseSucceed(() => null));
  if (!info || info.type !== "File" || Number(info.size) > WRAPPER_SCRIPT_MAX_BYTES) return null;
  const script = yield* fileSystem
    .readFileString(scriptPath)
    .pipe(Effect.orElseSucceed(() => null));
  if (!script?.startsWith("#!")) return null;

  const variables = new Map<string, string>();
  if (env.HOME) variables.set("HOME", env.HOME);
  const execLines: Array<ReadonlyArray<string>> = [];
  for (const line of script.split(/\r?\n/)) {
    const words = splitShellWords(line, variables);
    if (!words) {
      // Lines with pipes, tests, or redirects are not ours to read, but an
      // `exec` we cannot read means we cannot say what the launcher runs.
      if (/^\s*exec\s/.test(line)) return null;
      continue;
    }
    if (words[0] === "exec") execLines.push(words.slice(1));
    const assignment = words.length === 1 ? /^([A-Za-z_]\w*)=(.*)$/s.exec(words[0]!) : null;
    if (assignment) variables.set(assignment[1]!, assignment[2]!);
  }
  if (execLines.length !== 1) return null;
  const argv = execLines[0]!.at(-1) === "$@" ? execLines[0]!.slice(0, -1) : execLines[0]!;
  return argv.length > 0 && !argv.some((word) => word.includes("$@")) ? argv : null;
});

/**
 * Split one script line into words: bare text, `'…'`, and `"…"`, with `~`,
 * `$NAME`, and `${NAME}` expanded from `variables`. `$@` stays literal. Anything
 * richer (escapes, substitutions, pipes, redirects, `;`) returns null. A word
 * starting with `#` ends the line, so commented-out commands are never read.
 */
function splitShellWords(
  line: string,
  variables: ReadonlyMap<string, string>,
): Array<string> | null {
  const words: Array<string> = [];
  const wordPattern = /\s*(?:(#.*)|((?:[^\s'"]+|'[^']*'|"[^"]*")+))/y;
  let position = 0;
  for (;;) {
    wordPattern.lastIndex = position;
    const match = wordPattern.exec(line);
    if (!match) break;
    position = wordPattern.lastIndex;
    if (match[2] === undefined) break;
    let word = "";
    for (const [segment] of match[2].matchAll(/'[^']*'|"[^"]*"|[^'"]+/g)) {
      if (segment.startsWith("'")) {
        word += segment.slice(1, -1);
        continue;
      }
      const quoted = segment.startsWith('"');
      const text = quoted ? segment.slice(1, -1) : segment;
      if (/[\\`]/.test(text) || (!quoted && /[;&|<>()]/.test(text))) return null;
      const homeExpanded =
        !quoted && word === "" && /^~(?:\/|$)/.test(text)
          ? variables.has("HOME")
            ? `${variables.get("HOME")}${text.slice(1)}`
            : null
          : text;
      if (homeExpanded === null) return null;
      const expanded = expandShellVariables(homeExpanded, variables);
      if (expanded === null) return null;
      word += expanded;
    }
    words.push(word);
  }
  // An unterminated quote leaves text the word pattern could not consume.
  return line.slice(position).trim() === "" ? words : null;
}

function expandShellVariables(text: string, variables: ReadonlyMap<string, string>): string | null {
  let unknown = false;
  const expanded = text.replace(
    /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*)|(@))/g,
    (_, braced: string | undefined, bare: string | undefined, all: string | undefined) => {
      if (all) return "$@";
      const value = variables.get((braced ?? bare)!);
      if (value === undefined) unknown = true;
      return value ?? "";
    },
  );
  // Any `$` left over is an expansion we do not evaluate.
  return unknown || expanded.replaceAll("$@", "").includes("$") ? null : expanded;
}

/**
 * `[/path/to/]mise x|exec <spec> -- <bin>`, with no options before `--` and
 * no arguments after `<bin>`: in `mise x node -- node cli.js` the provider is
 * `cli.js`, not the node tool.
 */
function readMiseExec(argv: ReadonlyArray<string>, path: Path.Path): MiseLaunch | null {
  if (argv.length !== 5) return null;
  const [mise, subcommand, spec, separator, bin] = argv;
  if (!mise || commandName(mise, path).toLowerCase() !== "mise") return null;
  if (subcommand !== "x" && subcommand !== "exec") return null;
  if (!spec || spec.startsWith("-") || separator !== "--" || !bin) return null;
  if (mise !== "mise" && !path.isAbsolute(mise)) return null;
  return { kind: "bin", bin, executable: mise === "mise" ? null : mise, spec };
}

/**
 * `claude`, `npm:@openai/codex`, `claude@latest`, `npm:@openai/codex@0.1`.
 * The `@` that opens an npm scope follows the backend's colon or starts the spec.
 */
function splitToolSpec(spec: string): { readonly tool: string; readonly version: string | null } {
  const at = spec.lastIndexOf("@");
  return at > 0 && spec[at - 1] !== ":"
    ? { tool: spec.slice(0, at), version: spec.slice(at + 1) }
    : { tool: spec, version: null };
}

const findMiseOnPath = (env: NodeJS.ProcessEnv) =>
  resolveCommandPath("mise", { env }).pipe(
    Effect.catchTags({ CommandResolutionError: () => Effect.succeed(null) }),
  );

const MiseInstalledTools = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({
        version: Schema.String,
        install_path: Schema.String,
        active: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
);
const decodeMiseInstalledTools = Schema.decodeUnknownOption(MiseInstalledTools);

const MiseOutdatedTools = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Struct({ latest: Schema.String })),
);
const decodeMiseOutdatedTools = Schema.decodeUnknownOption(MiseOutdatedTools);

/**
 * Match the real binary against every install mise reports, so the tool name
 * is mise's own (alias, backend spec, custom data dir) rather than a guess
 * from directory names. Null when mise cannot list its installs or none
 * contains the binary.
 */
const findOwningTool = Effect.fn("findOwningMiseTool")(function* (input: {
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** The path T3 Code launches, before symlinks are followed. */
  readonly launchPath: string;
  /** The provider binary inside the install, before and after following symlinks. */
  readonly binPath: string;
  readonly realBinPath: string;
}) {
  const listing = yield* runInstallerProbe({
    executable: input.executable,
    args: ["ls", "--installed", "--json"],
    env: input.env,
    timeout: MISE_PROBE_TIMEOUT,
    maxBytes: MISE_PROBE_MAX_BYTES,
  });
  if (listing === null) return null;
  const tools = decodeMiseInstalledTools(listing);
  if (Option.isNone(tools)) {
    yield* Effect.logWarning("mise ls --json printed an unexpected shape", {
      executable: input.executable,
    });
    return null;
  }

  const fileSystem = yield* FileSystem.FileSystem;
  for (const [tool, installs] of Object.entries(tools.value)) {
    for (const install of installs) {
      const installPath = yield* fileSystem
        .realPath(install.install_path)
        .pipe(Effect.orElseSucceed(() => install.install_path));
      const relativeBinPath = pathBelow(installPath, input.realBinPath, input.platform);
      if (relativeBinPath === null) continue;

      if (/^(?:core:)?node(?:js)?$/.test(tool) && relativeBinPath.includes("node_modules/")) {
        return {
          kind: "npm-global",
          resolvedCommandPath: input.binPath,
          realCommandPath: input.realBinPath,
        } satisfies MiseOwnership;
      }
      if (!install.active) {
        return uncertain(
          `${tool}@${install.version} is installed by mise, but mise's config does not select it, so \`mise upgrade\` would not change it.`,
        );
      }
      // `mise activate` puts these version directories on PATH. An upgrade
      // installs beside them, so T3 Code keeps running the old version.
      if (
        [install.install_path, installPath].some(
          (versionDir) => pathBelow(versionDir, input.launchPath, input.platform) !== null,
        )
      ) {
        return uncertain(
          `T3 Code runs ${tool} from mise's fixed ${install.version} directory, which \`mise upgrade\` leaves in place. Point it at the mise shim instead.`,
        );
      }

      const outdated = yield* runInstallerProbe({
        executable: input.executable,
        args: ["outdated", "--json", tool],
        env: input.env,
        timeout: MISE_OUTDATED_TIMEOUT,
        maxBytes: MISE_PROBE_MAX_BYTES,
      });
      // `outdated` lists only tools behind their configured request, so a
      // missing entry means the active version is all `mise upgrade` reaches.
      // That is what keeps an exact pin from advertising an unreachable update.
      const latestVersion =
        outdated === null
          ? null
          : Option.match(decodeMiseOutdatedTools(outdated), {
              onNone: () => null,
              onSome: (outdatedTools) => outdatedTools[tool]?.latest ?? install.version,
            });
      return {
        kind: "tool",
        executable: input.executable,
        tool,
        latestVersion,
      } satisfies MiseOwnership;
    }
  }
  return null;
});

/** The part of `child` below `parent` with forward slashes, or null when it is not below. */
function pathBelow(parent: string, child: string, platform: NodeJS.Platform): string | null {
  const prefix = `${comparablePath(parent, platform)}/`;
  const candidate = comparablePath(child, platform);
  return candidate.startsWith(prefix) ? candidate.slice(prefix.length) : null;
}

function comparablePath(value: string, platform: NodeJS.Platform): string {
  const slashed = value.replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "win32" ? slashed.toLowerCase() : slashed;
}
