import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const root = readJson("package.json");

function workspacePackages(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(directory, entry.name, "package.json"))
    .filter(existsSync);
}

test("todas las aplicaciones y paquetes anuncian la versión raíz", () => {
  for (const path of [...workspacePackages("apps"), ...workspacePackages("packages")]) {
    const pkg = readJson(path);
    assert.equal(pkg.version, root.version, `${path} anuncia ${pkg.version}, no ${root.version}`);
  }
});

test("el instalador fuente no conserva una versión vieja y el release debe sellarla", () => {
  const installer = readFileSync("scripts/install-vps.sh", "utf8");
  const version = installer.match(/^VERSION="([^"]*)"$/m)?.[1];
  assert.equal(version, "");
  assert.match(installer, /Falta la versión:[^\n]*--version X\.Y\.Z/);
});

test("actualizar la VPS reinicia el servicio y verifica la versión que quedó viva", () => {
  const installer = readFileSync("scripts/install-vps.sh", "utf8");
  assert.doesNotMatch(installer, /systemctl enable --now distop/);
  assert.match(installer, /systemctl enable distop/);
  assert.match(installer, /systemctl restart distop/);
  assert.match(installer, /\/health[\s\S]*grep --fixed-strings --quiet [^\n]*version[^\n]*VERSION/);
});

test("el instalador deja una importación offline que detiene y recupera el servicio", () => {
  const installer = readFileSync("scripts/install-vps.sh", "utf8");
  assert.match(installer, /upsert_env DISTOP_IMAGE_DIGEST "\$IMAGE_DIGEST"/);
  assert.match(installer, /distop-import-community/);
  assert.match(installer, /systemctl stop distop/);
  assert.match(installer, /--network=none/);
  assert.match(installer, /--user 1000:1000/);
  assert.match(installer, /setpriv --reuid=1000 --regid=1000 --clear-groups test -r/);
  assert.doesNotMatch(installer, /--env-file="\$ENV_FILE"/);
  assert.match(installer, /--confirm-stopped/);
  assert.match(installer, /trap cleanup EXIT/);
});

test("el workflow sella el instalador VPS con la versión del tag", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");
  assert.match(workflow, /sed -i .*GITHUB_REF_NAME#v.*scripts\/install-vps\.sh/);
  assert.match(workflow, /grep -qx .*GITHUB_REF_NAME#v.*scripts\/install-vps\.sh/);
});
