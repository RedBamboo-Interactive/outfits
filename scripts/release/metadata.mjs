import { createHash } from "node:crypto"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const PLACEHOLDER_PREFIX = "REPLACE_WITH_"
const INPUT_KEYS = ["build", "classification", "compatibility", "dependencies", "identity", "inputType", "locks", "redbamboo", "redleaf", "runtimeRequirements", "schemaVersion", "targetPlatform", "toolchain"]

function fail(message) { throw new Error(message) }
function json(path) { return JSON.parse(readFileSync(path, "utf8")) }
function keys(value) { return Object.keys(value).sort() }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(keys(value)) !== JSON.stringify([...expected].sort())) fail(`${label} has unexpected or missing fields.`)
}
function canonical(value) {
  const sort = (item) => Array.isArray(item) ? item.map(sort) : item && typeof item === "object"
    ? Object.fromEntries(keys(item).map((key) => [key, sort(item[key])])) : item
  return `${JSON.stringify(sort(value), null, 2)}\n`
}
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true })
  if (result.error || result.status !== 0) fail((result.stderr || result.stdout || result.error?.message || `${command} failed`).trim())
  return result.stdout.trim()
}
function git(root, ...args) { return run("git", ["-C", root, ...args]) }
function detectPnpmVersion() {
  return process.platform === "win32"
    ? run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "corepack pnpm --version"])
    : run("corepack", ["pnpm", "--version"])
}
function hashFile(path) { return createHash("sha256").update(readFileSync(path)).digest("hex") }
function facts(path) { return { sizeBytes: statSync(path).size, sha256: hashFile(path) } }
function exactCommit(value, label) { if (!/^[a-f0-9]{40}$/.test(value)) fail(`${label} must be one full lowercase commit SHA.`) }
function cleanGit(root, label) { if (git(root, "status", "--porcelain=v1", "--untracked-files=all")) fail(`${label} checkout must be clean.`) }

export function validateExactVersionOverride(head, current, expectedVersion) {
  const headVersion = head.manifest.version
  if (head.input.identity.version !== headVersion || head.packageJson.version !== headVersion) fail("Committed Outfits version fields are inconsistent.")
  if (expectedVersion === headVersion) fail("An ephemeral release override must change the committed version.")
  if (current.manifest.version !== expectedVersion || current.input.identity.version !== expectedVersion || current.packageJson.version !== expectedVersion) fail("Ephemeral Outfits version fields must match the requested version.")
  const restored = structuredClone(current)
  restored.manifest.version = headVersion
  restored.input.identity.version = headVersion
  restored.packageJson.version = headVersion
  if (canonical(restored.manifest) !== canonical(head.manifest)
      || canonical(restored.input) !== canonical(head.input)
      || canonical(restored.packageJson) !== canonical(head.packageJson)) fail("Outfits checkout contains changes beyond the exact release version fields.")
}

function cleanOutfitsGit(root, input, manifest, packageJson) {
  const status = git(root, "status", "--porcelain=v1", "--untracked-files=all")
  if (!status) return
  const expectedPaths = ["plugin.json", "release/producer-input.v1.json", "web/package.json"]
  const entries = status.split(/\r?\n/)
  if (entries.length !== expectedPaths.length
      || entries.some((entry) => !entry.startsWith(" M "))
      || entries.map((entry) => entry.slice(3)).sort().some((path, index) => path !== expectedPaths[index])) fail("Outfits checkout must be clean except for the exact workflow-owned version fields.")
  const atHead = (path) => JSON.parse(git(root, "show", `HEAD:${path}`))
  validateExactVersionOverride({
    manifest: atHead("plugin.json"),
    input: atHead("release/producer-input.v1.json"),
    packageJson: atHead("web/package.json"),
  }, { manifest, input, packageJson }, input.identity.version)
}

export function validateInput(input, manifest, packageJson) {
  exactKeys(input, INPUT_KEYS, "producer input")
  exactKeys(input.identity, ["id", "version"], "identity")
  exactKeys(input.compatibility, ["kernelApi"], "compatibility")
  exactKeys(input.toolchain, ["dotnetSdk", "msbuild", "node", "pnpm"], "toolchain")
  exactKeys(input.redleaf, ["commit", "leafSdkPath", "repository"], "redleaf")
  exactKeys(input.redbamboo, ["commit", "inputs", "lockPath", "repository"], "redbamboo")
  exactKeys(input.build, ["backendProject", "frontendDirectory"], "build")
  exactKeys(input.targetPlatform, ["architecture", "operatingSystem"], "targetPlatform")
  if (input.schemaVersion !== 1 || input.inputType !== "outfits-extension-release-producer-input") fail("Unsupported producer input.")
  if (input.classification !== "optional") fail("Outfits must be classified optional.")
  if (input.redleaf.commit.startsWith(PLACEHOLDER_PREFIX)) fail("RedLeaf release-tool commit pin is unresolved; publication is blocked.")
  exactCommit(input.redleaf.commit, "RedLeaf release-tool pin")
  exactCommit(input.redbamboo.commit, "RedBamboo pin")
  if (input.redleaf.repository !== "RedBamboo-Interactive/redleaf" || input.redleaf.leafSdkPath !== "src/Leaf.Sdk") fail("RedLeaf Leaf.Sdk source is invalid.")
  if (input.redbamboo.repository !== "RedBamboo-Interactive/redbamboo-packages" || input.redbamboo.lockPath !== "pnpm-lock.yaml") fail("RedBamboo source is invalid.")
  if (manifest.id !== input.identity.id || manifest.version !== input.identity.version || manifest.kernelApi !== input.compatibility.kernelApi || !manifest.backend || !manifest.frontend) fail("plugin.json identity, compatibility, or extension layout drifted.")
  if (packageJson.name !== manifest.frontend.package || packageJson.name !== "@redbamboo/plugin-outfits") fail("Frontend package identity does not match plugin.json.")
  if (manifest.build !== undefined) fail("Source plugin.json must not contain release build evidence.")
  if (packageJson.packageManager !== `pnpm@${input.toolchain.pnpm}` || packageJson.engines?.node !== input.toolchain.node) fail("package.json Node/pnpm pins do not match producer input.")
  if (input.build.backendProject !== "src/Leaf.Plugins.Outfits/Leaf.Plugins.Outfits.csproj" || input.build.frontendDirectory !== "web") fail("Outfits build layout is invalid.")
  if (input.targetPlatform.operatingSystem !== "windows" || input.targetPlatform.architecture !== "x64") fail("Outfits release target must be windows/x64.")
  const expectedShared = [["redbamboo-ui", "@redbamboo/ui", "packages/ui"], ["redbamboo-utility", "@redbamboo/utility", "packages/utility"]]
  if (!Array.isArray(input.redbamboo.inputs) || JSON.stringify(input.redbamboo.inputs.map((item) => [item.id, item.name, item.sourcePath])) !== JSON.stringify(expectedShared)) fail("RedBamboo inputs must be exactly ui and utility.")
  for (const [index, item] of input.redbamboo.inputs.entries()) exactKeys(item, ["id", "name", "sourcePath"], `redbamboo.inputs[${index}]`)
  const declaredShared = Object.entries(packageJson.dependencies).filter(([name]) => name.startsWith("@redbamboo/")).map(([name]) => name).sort()
  if (JSON.stringify(declaredShared) !== JSON.stringify(expectedShared.map(([, name]) => name).sort())) fail("Frontend shared dependency fan-in drifted.")
  for (const [, name, sourcePath] of expectedShared) if (packageJson.dependencies[name] !== `link:../../redbamboo-packages/${sourcePath}`) fail(`${name} must be its declared local development link.`)
  const expectedLocks = [
    ["backend-nuget-lock", "nuget", "src/Leaf.Plugins.Outfits/packages.lock.json"],
    ["redbamboo-pnpm-lock", "npm", "redbamboo-packages/pnpm-lock.yaml"],
    ["tests-nuget-lock", "nuget", "tests/Leaf.Plugins.Outfits.Tests/packages.lock.json"],
    ["web-pnpm-lock", "npm", "web/pnpm-lock.yaml"],
  ]
  if (!Array.isArray(input.locks) || JSON.stringify(input.locks.map((item) => [item.id, item.ecosystem, item.path])) !== JSON.stringify(expectedLocks)) fail("Outfits lock evidence must be the real backend, test, frontend, and shared locks.")
  for (const [index, item] of input.locks.entries()) exactKeys(item, ["ecosystem", "id", "path"], `locks[${index}]`)
  if (!Array.isArray(input.dependencies) || input.dependencies.length !== 0 || !Array.isArray(input.runtimeRequirements) || input.runtimeRequirements.length !== 0) fail("Outfits currently has no extension dependencies or runtime requirements.")
}

export function buildMetadata(input, source) {
  return {
    schemaVersion: 1,
    metadataType: "redleaf-extension-release-metadata",
    classification: input.classification,
    compatibility: input.compatibility,
    targetPlatform: input.targetPlatform,
    buildId: `source-${source.outfitsCommit}`,
    builtAt: source.builtAt,
    repository: { id: input.identity.id, repositoryUrl: source.outfitsUrl, commit: source.outfitsCommit },
    toolchain: { ...input.toolchain, releaseTool: input.redleaf.commit },
    build: input.build,
    buildInputs: [
      { id: "leaf-sdk", repositoryUrl: source.redleafUrl, commit: input.redleaf.commit, sourcePath: input.redleaf.leafSdkPath },
      ...input.redbamboo.inputs.map((item) => ({ id: item.id, repositoryUrl: source.redbambooUrl, commit: input.redbamboo.commit, sourcePath: item.sourcePath })),
    ].sort((a, b) => a.id.localeCompare(b.id)),
    dependencyLocks: input.locks.map(({ id, ecosystem, path }) => ({ id, ecosystem, path })).sort((a, b) => a.path.localeCompare(b.path)),
    sboms: [],
    dependencies: input.dependencies,
    runtimeRequirements: input.runtimeRequirements,
  }
}

export function validateDescriptor(descriptor, metadata, artifactPath, lockFiles, expectedVersion) {
  const artifact = facts(artifactPath)
  if (descriptor.componentId !== "outfits" || descriptor.version !== expectedVersion || descriptor.classification !== "optional" || descriptor.componentKind !== "extension") fail("Descriptor identity or classification is invalid.")
  if (canonical(descriptor.compatibility) !== canonical(metadata.compatibility) || canonical(descriptor.evidence.buildInputs) !== canonical(metadata.buildInputs)) fail("Descriptor compatibility or build inputs drifted from metadata.")
  if (descriptor.evidence.repository.commit !== metadata.repository.commit || descriptor.evidence.build.backendProject !== metadata.build.backendProject || descriptor.evidence.build.frontendDirectory !== metadata.build.frontendDirectory) fail("Descriptor source or build layout is invalid.")
  if (descriptor.artifact.sha256 !== artifact.sha256 || descriptor.artifact.sizeBytes !== artifact.sizeBytes) fail("Descriptor artifact facts do not match actual bytes.")
  const expectedLocks = metadata.dependencyLocks.map((item) => ({ ...item, ...facts(lockFiles[item.id]) })).sort((a, b) => a.path.localeCompare(b.path))
  if (canonical(descriptor.evidence.dependencyLocks) !== canonical(expectedLocks)) fail("Descriptor lock facts do not match actual bytes.")
  if (descriptor.sboms.length !== 0) fail("Outfits does not declare an SBOM output.")
}

function args(values) {
  const parsed = new Map()
  for (let i = 0; i < values.length; i += 2) {
    if (!values[i]?.startsWith("--") || values[i + 1] === undefined) fail("Arguments must use --name value.")
    parsed.set(values[i].slice(2), values[i + 1])
  }
  return (name, optional = false) => parsed.get(name) ?? (optional ? undefined : fail(`--${name} is required.`))
}

function collect(get) {
  const repository = resolve(get("repository"))
  const redbamboo = resolve(get("redbamboo"))
  const redleaf = resolve(get("redleaf"))
  const input = json(get("input"))
  const manifest = json(resolve(repository, "plugin.json"))
  const packageJson = json(resolve(repository, "web/package.json"))
  validateInput(input, manifest, packageJson)
  cleanOutfitsGit(repository, input, manifest, packageJson)
  cleanGit(redbamboo, "RedBamboo")
  cleanGit(redleaf, "RedLeaf")
  const outfitsCommit = git(repository, "rev-parse", "HEAD")
  const expectedOutfitsCommit = get("source-commit")
  exactCommit(expectedOutfitsCommit, "Outfits source commit")
  if (outfitsCommit !== expectedOutfitsCommit) fail("Outfits checkout does not match the called workflow commit.")
  if (git(redbamboo, "rev-parse", "HEAD") !== input.redbamboo.commit || git(redleaf, "rev-parse", "HEAD") !== input.redleaf.commit) fail("A checkout does not match its immutable producer pin.")
  git(redleaf, "cat-file", "-e", `HEAD:${input.redleaf.leafSdkPath}`)
  for (const item of input.redbamboo.inputs) git(redbamboo, "cat-file", "-e", `HEAD:${item.sourcePath}`)
  const sourceEpoch = get("source-date-epoch")
  if (!/^\d+$/.test(sourceEpoch) || sourceEpoch !== git(repository, "show", "-s", "--format=%ct", "HEAD")) fail("SOURCE_DATE_EPOCH must equal the exact Outfits commit timestamp.")
  const actual = { node: process.version.slice(1), pnpm: detectPnpmVersion(), dotnetSdk: run("dotnet", ["--version"]), msbuild: run("dotnet", ["msbuild", "-version", "-nologo"]).split(/\r?\n/).at(-1) }
  for (const [name, value] of Object.entries(input.toolchain)) if (actual[name] !== value) fail(`Expected ${name} ${value}, got ${actual[name]}.`)
  const lockFiles = Object.fromEntries(input.locks.map((item) => [item.id, resolve(item.id === "redbamboo-pnpm-lock" ? redbamboo : repository, item.id === "redbamboo-pnpm-lock" ? input.redbamboo.lockPath : item.path)]))
  for (const [id, path] of Object.entries(lockFiles)) if (!statSync(path).isFile()) fail(`Lock '${id}' is missing.`)
  return { input, manifest, metadata: buildMetadata(input, { outfitsCommit, outfitsUrl: git(repository, "config", "--get", "remote.origin.url"), redbambooUrl: git(redbamboo, "config", "--get", "remote.origin.url"), redleafUrl: git(redleaf, "config", "--get", "remote.origin.url"), builtAt: new Date(Number(sourceEpoch) * 1000).toISOString() }), lockFiles }
}

function main() {
  const mode = process.argv[2]
  const get = args(process.argv.slice(3))
  const state = collect(get)
  if (mode === "generate") writeFileSync(get("output"), canonical(state.metadata), { encoding: "utf8", flag: "wx" })
  else if (mode === "validate") {
    const metadata = json(get("metadata"))
    if (canonical(metadata) !== canonical(state.metadata)) fail("Generated metadata is not deterministic for the checked-out inputs.")
    validateDescriptor(json(get("descriptor")), metadata, get("artifact"), state.lockFiles, state.manifest.version)
  } else fail("Mode must be generate or validate.")
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { main() } catch (error) { process.stderr.write(`release metadata: ${error.message}\n`); process.exitCode = 1 }
}

export { canonical, detectPnpmVersion, facts, hashFile }
