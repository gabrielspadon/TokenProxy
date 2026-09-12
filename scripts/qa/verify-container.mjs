#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  capabilityOptions, gitSha, packageVersion, parseOptions, prepareArtifacts, privateEnvironment,
  readSchemaVersion, resolveExpectedSchemaVersion, resolveExpectedLayoutVersion, runCapabilityMatrix, runCommand,
  schemaSha256, sha256File, validateManifest,
} from "./verify-standalone.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LABEL = "app.tokenproxy.qualification-owner";
const fail = (message) => { throw new Error(message); };
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const delay = (ms) => new Promise((accept) => setTimeout(accept, ms));

export function ownedContainer(value, owner, imageId) {
  if (!/^[a-f0-9]{64}$/u.test(value?.Id || "") || value.Config?.Labels?.[LABEL] !== owner || value.Image !== imageId) fail("container ownership or immutable image identity mismatch");
  return value;
}

export function publishedOrigin(value, containerPort) {
  const bindings = value.NetworkSettings?.Ports?.[`${containerPort}/tcp`];
  if (!Array.isArray(bindings) || bindings.length !== 1 || bindings[0].HostIp !== "127.0.0.1" || !/^[1-9][0-9]*$/u.test(bindings[0].HostPort)) fail("container must publish exactly one private loopback binding");
  const port = Number(bindings[0].HostPort);
  if (port > 65535 || port === 20127 || port === 20128) fail("container published a protected or invalid port");
  return `http://127.0.0.1:${port}`;
}

export function assertContainerRuntime(value, owner, imageId, networkId, dataDir) {
  ownedContainer(value, owner, imageId);
  const networks = Object.values(value.NetworkSettings?.Networks || {});
  if (networks.length !== 1 || networks[0].NetworkID !== networkId) fail("container is not isolated to its owned internal network");
  const mounts = value.Mounts || [];
  if (mounts.length !== 1 || mounts[0].Type !== "bind" || mounts[0].Source !== dataDir || mounts[0].Destination !== "/app/data" || mounts[0].RW !== true) fail("container persisted data mount is not the owned fixture");
  if (value.State?.Running !== true || value.State?.Health?.Status !== "healthy") fail("container has not reached Docker healthy state");
  return publishedOrigin(value, 20128);
}

async function readyJson(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let reason = "not ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.status === 200) return response.json();
      reason = `HTTP ${response.status}`;
    } catch (error) { reason = error.message; }
    await delay(100);
  }
  fail(`container readiness timed out: ${url}: ${reason}`);
}

export async function containerMain(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (!options.artifacts || !options.image) fail("require --artifacts <empty-directory> and --image <already-built-image>");
  if (process.platform !== "linux") fail("this container qualification supports a local Linux Docker daemon only");
  const candidate = { sha: options["candidate-sha"] || gitSha(ROOT), version: options["candidate-version"] || packageVersion(join(ROOT, "package.json")) };
  if (!/^[0-9a-f]{40}$/u.test(candidate.sha)) fail("candidate SHA must contain all 40 hex characters");
  const capability = capabilityOptions(options);
  const schemaVersion = await resolveExpectedSchemaVersion(options["expected-schema-version"]);
  const layoutVersion = await resolveExpectedLayoutVersion(options["expected-layout-version"]);
  const artifacts = resolve(options.artifacts);
  const runRoot = prepareArtifacts(artifacts);
  const env = privateEnvironment(runRoot);
  const receipt = { schema: "tokenproxy-container-qualification-v1", state: "failed", candidate, startedAt: new Date().toISOString(), starts: [], cleanup: [] };
  const owner = randomUUID();
  const networkName = `tp-qa-net-${owner}`;
  const resources = [];
  let networkId;
  let imageId;
  const docker = async (args, timeoutMs = 60_000) => {
    const result = await runCommand("docker", ["--host", "unix:///var/run/docker.sock", ...args], { cwd: ROOT, env, timeoutMs });
    if (result.code !== 0) fail(`docker ${args[0]} ${args[1] || ""} failed: ${result.stderr.slice(-2000)}`);
    return result.stdout.trim();
  };
  const inspect = async (id) => ownedContainer(JSON.parse(await docker(["container", "inspect", id]))[0], owner, imageId);
  const stop = async (id, requireClean = true) => {
    const before = await inspect(id);
    if (before.State.Running) await docker(["container", "stop", "--time", "10", id], 20_000);
    const after = await inspect(id);
    if (after.State.Running) fail("owned container still running after stop");
    const clean = after.State.ExitCode === 0 && !after.State.OOMKilled;
    if (requireClean && !clean) fail("container did not stop cleanly without forced kill");
    return { id, stopped: true, clean, exitCode: after.State.ExitCode, oomKilled: after.State.OOMKilled, finishedAt: after.State.FinishedAt };
  };
  try {
    const image = JSON.parse(await docker(["image", "inspect", options.image]))[0];
    imageId = image?.Id;
    if (!/^sha256:[a-f0-9]{64}$/u.test(imageId || "") || image.Os !== "linux" || !image.Config?.Healthcheck?.Test?.length) fail("image must have immutable Linux identity and a configured health check");
    for (const entry of image.Config.Env || []) {
      const separator = entry.indexOf("=");
      const name = entry.slice(0, separator);
      if (separator >= 0 && entry.slice(separator + 1) && /(?:API_?KEY|ACCESS_?TOKEN|REFRESH_?TOKEN|SECRET|PASSWORD|AUTHORIZATION|COOKIE|CREDENTIAL)/iu.test(name)) fail(`image embeds a credential-bearing environment variable: ${name}`);
    }
    receipt.image = { requested: options.image, id: imageId, os: image.Os, architecture: image.Architecture, variant: image.Variant || null, repoDigests: image.RepoDigests || [], entrypoint: image.Config.Entrypoint, command: image.Config.Cmd };
    const manifest = validateManifest(capability.manifest);
    receipt.capabilityManifest = { sha256: sha256File(capability.manifest), formatCells: manifest.cells.length, primaryCells: manifest.primaryEndpoints.length };
    networkId = await docker(["network", "create", "--internal", "--label", `${LABEL}=${owner}`, networkName]);
    const network = JSON.parse(await docker(["network", "inspect", networkId]))[0];
    if (network.Id !== networkId || network.Internal !== true || network.Labels?.[LABEL] !== owner) fail("Docker network isolation or ownership mismatch");
    receipt.network = { id: networkId, internal: network.Internal, owner };

    const providerDirectory = realpathSync(dirname(capability.providerStubModule));
    const providerModule = `/fixture/${capability.providerStubModule.split("/").at(-1)}`;
    const providerCode = `const {startProviderStub}=await import(${JSON.stringify(providerModule)});const p=await startProviderStub({host:'0.0.0.0',port:20210});process.on('SIGTERM',async()=>{await p.close();process.exit(0)});`;
    const providerId = await docker(["container", "create", "--name", `tp-qa-provider-${owner}`, "--label", `${LABEL}=${owner}`, "--network", networkId, "--network-alias", "fixture-provider", "--publish", "127.0.0.1::20210", "--mount", `type=bind,src=${providerDirectory},dst=/fixture,readonly`, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--entrypoint", "node", imageId, "--input-type=module", "-e", providerCode]);
    resources.push(providerId);
    await inspect(providerId);
    await docker(["container", "start", providerId]);
    const providerOrigin = publishedOrigin(await inspect(providerId), 20210);
    const providerControlUrl = `${providerOrigin}/__tokenproxy_fixture/control`;
    await readyJson(providerControlUrl);

    const authFile = join(runRoot, "authorization");
    const seed = await runCommand(process.execPath, [capability.seedScript], {
      cwd: ROOT,
      env: privateEnvironment(runRoot, { CAPABILITY_PROVIDER_BASE_URL: "http://fixture-provider:20210/v1", CAPABILITY_AUTH_FILE: authFile }),
      timeoutMs: 60_000,
    });
    writeFileSync(join(runRoot, "seed-stdout.log"), seed.stdout, { mode: 0o600 });
    writeFileSync(join(runRoot, "seed-stderr.log"), seed.stderr, { mode: 0o600 });
    if (seed.code !== 0) fail(`container fixture seed failed: ${seed.stderr.slice(-2000)}`);
    const database = join(runRoot, "data/db/data.sqlite");
    if (!existsSync(database)) fail("container seed did not create fixture database");
    const authorization = readFileSync(authFile, "utf8").trim();
    if (!authorization.startsWith("Bearer ")) fail("container fixture authorization is missing");
    const seededSchemaVersion = readSchemaVersion(database);
    const seededLayoutVersion = readSchemaVersion(database, "backupSchemaVersion");
    const seededSchemaSha256 = schemaSha256(database);
    if (seededSchemaVersion > schemaVersion || seededLayoutVersion > layoutVersion) fail("fixture schema is newer than the image");
    const dataDir = realpathSync(join(runRoot, "data"));
    const containerEnv = privateEnvironment(runRoot, { DATA_DIR: "/app/data", HOME: "/tmp/qa-home", TMPDIR: "/tmp", PORT: "20128", HOSTNAME: "0.0.0.0" });
    const permittedEnv = ["DATA_DIR", "HOME", "TMPDIR", "PORT", "HOSTNAME", "NODE_ENV", "NEXT_TELEMETRY_DISABLED", "TOKENPROXY_NO_UPDATE", "MODEL_CATALOG_SYNC", "MODEL_CAPABILITY_OVERRIDES", "JWT_SECRET", "API_KEY_SECRET", "MACHINE_ID_SALT", "DB_ENCRYPTION_KEY", "INITIAL_PASSWORD"];
    const envFile = join(runRoot, "container.env");
    writeFileSync(envFile, `${permittedEnv.map((key) => `${key}=${containerEnv[key]}`).join("\n")}\n`, { mode: 0o600 });
    const gatewayId = await docker(["container", "create", "--name", `tp-qa-gateway-${owner}`, "--label", `${LABEL}=${owner}`, "--network", networkId, "--publish", "127.0.0.1::20128", "--mount", `type=bind,src=${dataDir},dst=/app/data`, "--env-file", envFile, imageId]);
    resources.push(gatewayId);
    await inspect(gatewayId);

    for (let index = 0; index < 2; index += 1) {
      await docker(["container", "start", gatewayId]);
      const baseUrl = publishedOrigin(await inspect(gatewayId), 20128);
      const health = await readyJson(`${baseUrl}/api/health`);
      const readiness = await readyJson(`${baseUrl}/api/ready`);
      const version = await readyJson(`${baseUrl}/api/version`);
      if (health.ok !== true || readiness.ready !== true || readiness.buildSha !== candidate.sha || version.buildSha !== candidate.sha || version.currentVersion !== candidate.version) fail("started image did not serve exact healthy candidate identity");
      let runtime;
      const deadline = Date.now() + 90_000;
      do {
        runtime = await inspect(gatewayId);
        if (runtime.State.Health?.Status === "healthy") break;
        if (!runtime.State.Running || runtime.State.Health?.Status === "unhealthy") fail("started image failed its own Docker health check");
        await delay(500);
      } while (Date.now() < deadline);
      assertContainerRuntime(runtime, owner, imageId, networkId, dataDir);
      const entry = { index: index + 1, containerId: gatewayId, startedAt: runtime.State.StartedAt, baseUrl, health, readiness, version, dockerHealth: runtime.State.Health.Status };
      receipt.starts.push(entry);
      entry.runtime = JSON.parse(await docker(["container", "exec", gatewayId, "node", "-p", "JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,modulesAbi:process.versions.modules})"]));
      entry.capability = await runCapabilityMatrix({ matrixScript: capability.matrixScript, baseUrl, providerControlUrl, authorization, env });
      entry.stop = await stop(gatewayId);
      entry.schemaVersion = readSchemaVersion(database);
      entry.layoutVersion = readSchemaVersion(database, "backupSchemaVersion");
      if (entry.schemaVersion !== schemaVersion) fail(`image left schemaVersion ${entry.schemaVersion}; expected ${schemaVersion}`);
      if (entry.layoutVersion !== layoutVersion) fail(`image left backupSchemaVersion ${entry.layoutVersion}; expected ${layoutVersion}`);
    }
    if (receipt.starts[0].startedAt === receipt.starts[1].startedAt) fail("container restart was not observed");
    const reopenedSchemaSha256 = schemaSha256(database);
    receipt.persistence = { mountType: "bind", seededSchemaVersion, seededLayoutVersion, seedSchemaVersion: seededSchemaVersion, seedScriptSha256: sha256File(capability.seedScript), seededSchemaSha256, reopenedSchemaSha256, migrationExercised: (seededSchemaVersion < schemaVersion || seededLayoutVersion < layoutVersion) && seededSchemaSha256 !== reopenedSchemaSha256, migratedSchemaVersion: receipt.starts[0].schemaVersion, reopenedSchemaVersion: receipt.starts[1].schemaVersion, reopenedLayoutVersion: receipt.starts[1].layoutVersion, reopened: true, fixtureAuthorizationWorkedAfterRestart: true, databaseSha256: sha256File(database) };
    receipt.state = "passed";
    receipt.reason = "started image passed immutable identity, isolated fake-provider matrix, persisted-volume restart and clean shutdown";
  } catch (error) { receipt.reason = error.message; }
  finally {
    for (const id of resources.reverse()) {
      try {
        const stopped = await stop(id, false);
        if (!stopped.clean) receipt.state = "failed";
        const logs = await runCommand("docker", ["--host", "unix:///var/run/docker.sock", "container", "logs", id], { cwd: ROOT, env, timeoutMs: 60_000 });
        writeFileSync(join(runRoot, `${id}-stdout.log`), logs.stdout, { mode: 0o600 });
        writeFileSync(join(runRoot, `${id}-stderr.log`), logs.stderr, { mode: 0o600 });
        if (logs.code !== 0) receipt.state = "failed";
        await inspect(id);
        await docker(["container", "rm", id]);
        const remaining = await docker(["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", `id=${id}`]);
        if (remaining) fail("removed owned container still exists");
        receipt.cleanup.push({ ...stopped, removed: true });
      } catch (error) { receipt.state = "failed"; receipt.cleanup.push({ id, error: error.message }); }
    }
    if (networkId) {
      try {
        const value = JSON.parse(await docker(["network", "inspect", networkId]))[0];
        if (value.Id !== networkId || value.Labels?.[LABEL] !== owner || Object.keys(value.Containers || {}).length) fail("refusing to remove unowned or occupied network");
        await docker(["network", "rm", networkId]);
        if (await docker(["network", "ls", "--quiet", "--no-trunc", "--filter", `id=${networkId}`])) fail("removed owned network still exists");
        receipt.network.removed = true;
      } catch (error) { receipt.state = "failed"; receipt.networkCleanupError = error.message; }
    }
  }
  receipt.finishedAt = new Date().toISOString();
  save(join(artifacts, "container-evidence.json"), receipt);
  console.log(`${receipt.state.toUpperCase()} ${receipt.reason}; evidence=${join(artifacts, "container-evidence.json")}`);
  return receipt.state === "passed" ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) containerMain().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.message); process.exitCode = 1; });
