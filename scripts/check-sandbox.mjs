// Verifies, from inside the hardened container, that Chromium's native sandbox
// is active for an unprivileged UID: no sandbox-disable launch flag, a renderer
// in its own user namespace with a nested PID namespace and an extra seccomp
// filter, and no ambient container capabilities.
import { chromium } from 'playwright-core';
import { readFile, readlink } from 'node:fs/promises';

if (process.getuid?.() !== 1000) throw new Error('Sandbox verification requires unprivileged UID 1000');
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
try {
  const page = await browser.newPage();
  await page.setContent('<button>Sandboxed renderer</button>');
  const ownUserNamespace = await readlink('/proc/self/ns/user');
  const ownStatus = await readFile('/proc/self/status', 'utf8');
  const ownFilters = Number(/^Seccomp_filters:\s+(\d+)$/m.exec(ownStatus)?.[1]);
  const diagnosticsSession = await browser.newBrowserCDPSession();
  // Browser.getBrowserCommandLine is only populated when --enable-automation is
  // set, which Playwright never passes, so read the kernel's copy of the real
  // argv instead. This is the actual launched command line, not a DOM claim.
  const { processInfo } = await diagnosticsSession.send('SystemInfo.getProcessInfo');
  const browserProcess = processInfo.find(process => process.type === 'browser');
  if (!browserProcess) throw new Error('CDP reported no browser process');
  const browserArgv = (await readFile(`/proc/${browserProcess.id}/cmdline`, 'utf8')).split('\0').filter(Boolean);
  const banned = browserArgv.filter(argument => /^--(no-sandbox|disable-seccomp-filter-sandbox|disable-namespace-sandbox|disable-setuid-sandbox|disable-gpu-sandbox)$/.test(argument));
  if (banned.length) throw new Error(`Sandbox-disable launch argument detected: ${banned.join(' ')}`);
  // CDP identifies live renderers even when an emulator leaves /proc/cmdline
  // with the original zygote title. This is process evidence, not a DOM claim.
  const renderers = [];
  for (const processInfo_ of processInfo.filter(process => process.type === 'renderer')) {
    const pid = String(processInfo_.id);
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const userNamespace = await readlink(`/proc/${pid}/ns/user`);
    const pidNamespace = await readlink(`/proc/${pid}/ns/pid`);
    const filters = Number(/^Seccomp_filters:\s+(\d+)$/m.exec(status)?.[1]);
    const nestedPid = /^NSpid:\s+\d+\s+\d+/m.test(status);
    // Every layer is required, and a failure names the layer and the observed
    // values so an emulated or misconfigured runtime is diagnosable rather than
    // silently tolerated. Under a foreign-architecture emulator Chromium can
    // decide its seccomp probe is unsupported and skip that one layer; the
    // gate still refuses it, and native CI runners verify each architecture.
    if (userNamespace === ownUserNamespace) throw new Error(`Renderer user namespace not isolated: ${JSON.stringify({ pid, ownUserNamespace, userNamespace })}`);
    if (!nestedPid) throw new Error(`Renderer is not in a nested PID namespace: ${JSON.stringify({ pid, pidNamespace })}`);
    if (!(filters > ownFilters)) throw new Error(`Renderer has no additional seccomp filter: ${JSON.stringify({ pid, ownFilters, filters, note: 'the container seccomp profile is active but the renderer sandbox seccomp layer was not installed' })}`);
    renderers.push({ pid, userNamespace, pidNamespace, filters, nestedPid });
  }
  if (!renderers.length) throw new Error('No live renderer to verify');
  const diagnostics = { ownUserNamespace, ownFilters, browserSpawnedBy: browserArgv[0], browserArgvLength: browserArgv.length, renderers };
  const proc = await readFile('/proc/self/status', 'utf8');
  if (!/^NoNewPrivs:\s+1$/m.test(proc) || !/^CapEff:\s+0+$/m.test(proc)) throw new Error('Container privileges exceed expected policy');
  console.log(JSON.stringify({ ok: true, node: process.version, uid: process.getuid(), browser: browser.version(), architecture: process.arch, diagnostics }));
} finally { await browser.close(); }
