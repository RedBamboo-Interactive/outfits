import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import test from "node:test"
import { buildMetadata, canonical, detectPnpmVersion, hashFile, validateExactVersionOverride, validateInput } from "../scripts/release/metadata.mjs"

const root = resolve(import.meta.dirname, "..")
const readText = (path) => readFileSync(join(root, path), "utf8").replaceAll("\r\n", "\n")
const readJson = (path) => JSON.parse(readText(path))
const manifest = readJson("plugin.json")
const packageJson = readJson("web/package.json")
const producer = readJson("release/producer-input.v1.json")
const dotnetSdk = readJson("global.json")

test("cross-repository bridge retains the scoped producer token", () => {
  const workflow = readFileSync(join(root, ".github/workflows/release-candidate.yml"), "utf8")
  assert.match(workflow, /GH_TOKEN: \$\{\{ secrets\.CROSS_REPO_TOKEN \|\| github\.token \}\}/)
  assert.doesNotMatch(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/)
})
const centralRedLeafCommit = "4bf0894014b392e60cf0b5c6ca85920428ba7516"
const validProducer = () => structuredClone(producer)

test("automated version overrides can change only the three version fields", () => {
  const head = { manifest: structuredClone(manifest), input: structuredClone(producer), packageJson: structuredClone(packageJson) }
  const current = structuredClone(head)
  current.manifest.version = "0.1.1"
  current.input.identity.version = "0.1.1"
  current.packageJson.version = "0.1.1"
  assert.doesNotThrow(() => validateExactVersionOverride(head, current, "0.1.1"))
  current.manifest.description = "unexpected mutation"
  assert.throws(() => validateExactVersionOverride(head, current, "0.1.1"), /beyond the exact release version fields/)
  const inconsistent = structuredClone(head)
  inconsistent.manifest.version = "0.1.1"
  assert.throws(() => validateExactVersionOverride(head, inconsistent, "0.1.1"), /must match the requested version/)
  assert.throws(() => validateExactVersionOverride(head, head, manifest.version), /must change the committed version/)
})

test("repository SDK selection is exact and the packer runs inside the component checkout", () => {
  assert.deepEqual(dotnetSdk, {
    sdk: {
      version: producer.toolchain.dotnetSdk,
      rollForward: "disable",
      allowPrerelease: false,
    },
  })
  const workflow = readFileSync(join(root, ".github/workflows/release-candidate.yml"), "utf8").replaceAll("\r\n", "\n")
  assert.match(workflow, /workflow_call:\n    inputs:/)
  assert.match(workflow, /workflow_dispatch:\n    inputs:/)
  assert.ok((workflow.match(/inputs\.source_commit \|\| github\.workflow_sha/g) ?? []).length >= 3)
  assert.match(workflow, /name: Invoke [^\n]*RedLeaf[^\n]*\n\s+working-directory: outfits/)
  assert.doesNotMatch(workflow, /-notcmatch/)
})

test("Outfits is an optional versioned backend and frontend extension", () => {
  assert.doesNotThrow(() => validateInput(validProducer(), manifest, packageJson))
  assert.equal(detectPnpmVersion(), producer.toolchain.pnpm)
  assert.equal(manifest.id, "outfits")
  assert.equal(manifest.version, packageJson.version)
  assert.equal(manifest.kernelApi, "^0.1.0")
  assert.deepEqual(manifest.permissions, [])
  assert.equal(producer.classification, "optional")
  assert.equal(producer.build.backendProject, "src/Leaf.Plugins.Outfits/Leaf.Plugins.Outfits.csproj")
  assert.equal(producer.build.frontendDirectory, "web")
})

test("generic extension inputs are only Leaf.Sdk, ui, utility, and normal locks", () => {
  const backend = readText(producer.build.backendProject)
  assert.deepEqual(producer.redleaf, {
    repository: "RedBamboo-Interactive/redleaf",
    commit: centralRedLeafCommit,
    leafSdkPath: "src/Leaf.Sdk",
  })
  assert.match(backend, /PackageReference Include="Leaf\.Sdk"/)
  assert.match(backend, /<RestorePackagesWithLockFile>true<\/RestorePackagesWithLockFile>/)
  assert.doesNotMatch(backend, /AppHost/)
  assert.deepEqual(producer.redbamboo.inputs.map(({ id, name, sourcePath }) => ({ id, name, sourcePath })), [
    { id: "redbamboo-ui", name: "@redbamboo/ui", sourcePath: "packages/ui" },
    { id: "redbamboo-utility", name: "@redbamboo/utility", sourcePath: "packages/utility" },
  ])
  assert.deepEqual(producer.locks.map(({ id, ecosystem, path }) => ({ id, ecosystem, path })), [
    { id: "backend-nuget-lock", ecosystem: "nuget", path: "src/Leaf.Plugins.Outfits/packages.lock.json" },
    { id: "redbamboo-pnpm-lock", ecosystem: "npm", path: "redbamboo-packages/pnpm-lock.yaml" },
    { id: "tests-nuget-lock", ecosystem: "nuget", path: "tests/Leaf.Plugins.Outfits.Tests/packages.lock.json" },
    { id: "web-pnpm-lock", ecosystem: "npm", path: "web/pnpm-lock.yaml" },
  ])
})

test("lock evidence hashes actual normal lockfile bytes", () => {
  for (const lock of producer.locks.filter((item) => item.id !== "redbamboo-pnpm-lock")) {
    const path = join(root, lock.path)
    const independent = createHash("sha256").update(readFileSync(path)).digest("hex")
    assert.equal(hashFile(path), independent)
    assert.match(independent, /^[a-f0-9]{64}$/)
  }
  const lock = readText("web/pnpm-lock.yaml")
  assert.match(lock, /link:\.\.\/\.\.\/redbamboo-packages\/packages\/ui/)
  assert.match(lock, /link:\.\.\/\.\.\/redbamboo-packages\/packages\/utility/)
})

test("metadata is deterministic and channel-neutral", () => {
  const source = { outfitsCommit: "b".repeat(40), outfitsUrl: "https://github.com/RedBamboo-Interactive/outfits", redbambooUrl: "https://github.com/RedBamboo-Interactive/redbamboo-packages", redleafUrl: "https://github.com/RedBamboo-Interactive/redleaf", builtAt: "2026-08-01T19:18:41.000Z" }
  const first = canonical(buildMetadata(validProducer(), source))
  assert.equal(first, canonical(buildMetadata(validProducer(), source)))
  assert.doesNotMatch(first, /stable|nightly|channel|run_id|run_attempt/i)
  const metadata = JSON.parse(first)
  assert.equal(metadata.build.backendProject, producer.build.backendProject)
  assert.equal(metadata.build.frontendDirectory, producer.build.frontendDirectory)
  assert.deepEqual(metadata.sboms, [])
  assert.deepEqual(metadata.buildInputs.map((item) => item.id), ["leaf-sdk", "redbamboo-ui", "redbamboo-utility"])
})

test("an unresolved RedLeaf tool and Leaf.Sdk pin fails closed and none is checked in", () => {
  const placeholder = ["REPLACE", "WITH", "REDLEAF", "RELEASE", "TOOL", "COMMIT"].join("_")
  const unresolved = { ...validProducer(), redleaf: { ...producer.redleaf, commit: placeholder } }
  assert.throws(() => validateInput(unresolved, manifest, packageJson), /publication is blocked/)
  let count = 0
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", "artifacts", "bin", "obj"].includes(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (statSync(path).size < 1_000_000) count += readFileSync(path, "utf8").split(placeholder).length - 1
    }
  }
  walk(root)
  assert.equal(count, 0)
})

test("workflow pins actions, checks the immutable workflow revision, and invokes channel-neutral ingestion once", () => {
  const workflow = readText(".github/workflows/release-candidate.yml")
  const actionRefs = [...workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)].map((match) => match[1])
  assert.ok(actionRefs.length >= 5)
  for (const ref of actionRefs) assert.match(ref, /^[a-f0-9]{40}$/)
  assert.doesNotMatch(workflow, /github\.sha|--channel|stable|nightly|candidate (build|finalize)|registry|signer|id-token:\s*write/i)
  assert.match(workflow, /ref: \$\{\{ inputs\.source_commit \|\| github\.workflow_sha \}\}/)
  assert.match(workflow, /--source-commit \"\$\{\{ inputs\.source_commit \|\| github\.workflow_sha \}\}\"/)
  assert.equal((workflow.match(/candidate ingest-extension/g) ?? []).length, 1)
  assert.match(workflow, /corepack pnpm install --frozen-lockfile/g)
  const toolRestore = workflow.indexOf("dotnet restore ../redleaf/tools/RedLeaf.ReleaseTool/RedLeaf.ReleaseTool.csproj --locked-mode --nologo")
  const toolBuild = workflow.indexOf("dotnet build ../redleaf/tools/RedLeaf.ReleaseTool/RedLeaf.ReleaseTool.csproj --configuration Release --no-restore --nologo")
  const packer = workflow.indexOf("../redleaf/scripts/build-leafpkg-release.ps1")
  const candidateDll = workflow.indexOf("../redleaf/tools/RedLeaf.ReleaseTool/bin/Release/net9.0/RedLeaf.ReleaseTool.dll")
  assert.ok(toolRestore >= 0 && toolBuild > toolRestore)
  assert.ok(packer > toolBuild && candidateDll > toolBuild)
})

test("producer identity and producer artifact URL are canonical and derived", () => {
  const workflow = readText(".github/workflows/release-candidate.yml")
  const surface = [workflow, readText("release/producer-input.v1.json"), readText("scripts/release/metadata.mjs"), readText("web/package.json")].join("\n")
  for (const repository of ["RedBamboo-Interactive/outfits", "RedBamboo-Interactive/redleaf", "RedBamboo-Interactive/redbamboo-packages"]) assert.match(surface, new RegExp(repository.replace("/", "\\/")))
  assert.equal(producer.toolchain.node, "22.23.1")
  assert.equal(packageJson.engines.node, "22.23.1")
  assert.match(workflow, /node-version: 22\.23\.1/)
  assert.doesNotMatch(workflow, /central_release_tag|CENTRAL_RELEASE_TAG/)
  assert.doesNotMatch(workflow, /artifact_url|ARTIFACT_URL|inputs\.artifact_url/)
  assert.match(workflow, /\$artifactName = "outfits-\$version\.leafpkg"/)
  assert.match(workflow, /\$artifactUrl = "https:\/\/github\.com\/RedBamboo-Interactive\/outfits\/releases\/download\/outfits-unsigned-candidates\/\$artifactName"/)
  assert.match(workflow, /--artifact-url "\$artifactUrl"/)
  assert.match(workflow, /Candidate artifact URL drifted from the canonical producer URL/)
})

test("rolling unsigned acquisition bridge is serialized, append-only, and exact", () => {
  const workflow = readText(".github/workflows/release-candidate.yml")
  const bridgeStart = workflow.indexOf("\n  bridge:")
  assert.ok(bridgeStart > 0)
  const candidate = workflow.slice(0, bridgeStart)
  const bridge = workflow.slice(bridgeStart)
  assert.match(candidate, /^permissions:\n  contents: read$/m)
  assert.doesNotMatch(candidate, /contents: write|actions: write|id-token: write/)
  assert.match(bridge, /concurrency:\n      group: outfits-unsigned-candidate-bridge\n      cancel-in-progress: false/)
  assert.match(bridge, /permissions:\n      actions: read\n      contents: write/)
  assert.doesNotMatch(bridge, /id-token: write|actions: write/)
  assert.match(bridge, /\$tag = 'outfits-unsigned-candidates'/)
  assert.match(bridge, /gh release create \$tag --prerelease --latest=false/)
  assert.match(bridge, /-not \$release\.isPrerelease/)
  assert.match(bridge, /\$candidateId -cnotmatch '\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\{0,199\}\$'/)
  assert.match(bridge, /bridge-assets\/\$\{candidateId\}\.candidate\.json/)
  assert.match(bridge, /bridge-assets\/\$artifactName/)
  assert.doesNotMatch(bridge, /visibility|already be public|public prerelease/i)
  assert.match(bridge, /\$existingNames -contains \$file\.Name/)
  assert.match(bridge, /Immutable bridge asset collision/)
  assert.match(bridge, /gh release upload \$tag \$file\.FullName/)
  assert.doesNotMatch(bridge, /--clobber|gh release delete/)
  assert.equal((bridge.match(/gh release download \$tag --pattern \$file\.Name/g) ?? []).length, 2)
  assert.match(bridge, /Could not re-download required bridge asset/)
  assert.match(bridge, /Re-downloaded bridge asset failed exact SHA-256 verification/)
  assert.ok((bridge.match(/Get-FileHash -LiteralPath/g) ?? []).length >= 5)
})

test("package boundary permits only immutable extension payload and evidence", () => {
  const workflow = readText(".github/workflows/release-candidate.yml")
  assert.match(workflow, /Release package contains a path outside immutable code\/assets\/manifests/)
  assert.match(workflow, /Release package contains a private-state-shaped path/)
  for (const allowed of ["backend/", "web/dist/", "seeds/", "release/extension-build-evidence.v1.json"]) assert.match(workflow, new RegExp(allowed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  for (const privatePath of ["portraits?", "outfits?", "renders?", "daily", "history", "mood", "prompts?", "outputs?", "uploads?", "references?", "images?", "credential", "token", "cache", "logs", "database", "local", "working"]) assert.match(workflow, new RegExp(privatePath, "i"))
  assert.doesNotMatch(workflow, /Invoke-RestMethod|Invoke-WebRequest|Start-Service|Restart-Service|id-token:\s*write/)
})

test("unsigned handoff is retained for the bridge without additional release machinery", () => {
  const workflow = readText(".github/workflows/release-candidate.yml")
  const upload = workflow.indexOf("actions/upload-artifact@")
  const bridge = workflow.indexOf("\n  bridge:")
  assert.ok(upload > 0 && bridge > upload)
  for (const path of ["outfits/artifacts/outfits-${{ steps.pins.outputs.version }}.leafpkg", "outfits/artifacts/outfits-candidate.unsigned.json", "outfits/artifacts/outfits-signature-input.json"]) assert.match(workflow, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.match(workflow, /retention-days: 1/)
  assert.match(workflow, /actions\/download-artifact@[a-f0-9]{40}/)
  assert.match(workflow, /name: outfits-\$\{\{ needs\.candidate\.outputs\.version \}\}-\$\{\{ inputs\.source_commit \|\| github\.workflow_sha \}\}-unsigned-release-inputs/)
  assert.doesNotMatch([readText("scripts/release/metadata.mjs"), workflow].join("\n"), /treeId|subtree|fileInventory|payloadSha256|signatureDomain|cyclonedx|private key|registry snapshot|channel pointer|feed-publish|pointer-prepare/i)
})
