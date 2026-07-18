import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const deployPath = fileURLToPath(new URL("./deploy.sh", import.meta.url));

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

test("direct deploy releases its remote lock after smoke and cleanup", () => {
  const workdir = mkdtempSync(join(tmpdir(), "webai-deploy-controller-"));
  try {
    const bin = join(workdir, "bin");
    mkdirSync(bin);
    mkdirSync(join(workdir, "dist"));
    writeFileSync(
      join(workdir, "dist", "index.html"),
      '<script type="module" src="/_astro/current-build.js"></script>',
    );

    writeExecutable(
      join(bin, "ssh"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"flock --exclusive --nonblock"* ]]; then
  printf 'READY\n'
  cat >/dev/null
else
  cat >/dev/null
fi
`,
    );
    writeExecutable(join(bin, "rsync"), "#!/usr/bin/env bash\nexit 0\n");
    writeExecutable(
      join(bin, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
headers=''
body=''
url=''
while (($#)); do
  case "$1" in
    --dump-header) headers="$2"; shift 2 ;;
    --output) body="$2"; shift 2 ;;
    --connect-timeout|--max-time) shift 2 ;;
    --fail|--silent|--show-error) shift ;;
    *) url="$1"; shift ;;
  esac
done
content_type='text/html; charset=utf-8'
if [[ "\${url}" == *.js ]]; then
  content_type='application/javascript'
fi
printf 'HTTP/1.1 200 OK\nContent-Type: %s\nCross-Origin-Opener-Policy: same-origin\nCross-Origin-Embedder-Policy: require-corp\n' "\${content_type}" >"\${headers}"
printf 'ok\n' >"\${body}"
`,
    );

    const result = spawnSync("bash", [deployPath], {
      cwd: workdir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      timeout: 5_000,
    });

    assert.equal(result.signal, null, `deploy timed out: ${result.stderr}`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Deployed directly/);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
