// W3b launchd 常驻：生成/安装/卸载 com.du.memoryd plist，默认 dry-run。
// 注意：macOS launchd 不继承 shell PATH，ProgramArguments 必须写 node 的绝对路径（nvm 升级会失效）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPT = path.resolve(HERE, '..', 'bin', 'memoryd.mjs');

export const LAUNCHD_LABEL = 'com.du.memoryd';

export function plistPath(home = os.homedir()) {
  return path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

export function buildPlist({ nodePath, scriptPath, root, port, logDir }) {
  const args = [nodePath, scriptPath, 'serve', '--port', String(port), '--root', root]
    .map((s) => `    <string>${escapeXml(s)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(root)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logDir, 'memoryd.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logDir, 'memoryd.err.log'))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function uid() {
  return process.getuid ? process.getuid() : 501;
}

function launchctl(args) {
  return spawnSync('launchctl', args, { encoding: 'utf8', timeout: 10000 });
}

/** 生成安装计划（dry-run 与 --yes 共用）。 */
export function planInstall(config, { home = os.homedir(), nodePath = process.execPath, scriptPath } = {}) {
  const script = scriptPath || DEFAULT_SCRIPT;
  return {
    label: LAUNCHD_LABEL,
    nodePath,
    scriptPath: script,
    root: config.root,
    port: config.port,
    plistPath: plistPath(home),
    plist: buildPlist({
      nodePath,
      scriptPath: script,
      root: config.root,
      port: config.port,
      logDir: config.outDir
    })
  };
}

/** 安装服务；默认只返回计划，传 yes 才写文件并加载。 */
export function install(config, opts = {}) {
  const home = opts.home || os.homedir();
  const plan = planInstall(config, {
    home,
    nodePath: opts.nodePath,
    scriptPath: opts.scriptPath
  });
  if (!opts.yes) return { dryRun: true, ...plan, wrote: false, loaded: false };
  if (process.platform !== 'darwin') throw new Error('launchd 只在 macOS 可用');
  if (!fs.existsSync(plan.nodePath)) throw new Error(`node 路径不存在：${plan.nodePath}`);
  if (!fs.existsSync(plan.scriptPath)) throw new Error(`入口不存在：${plan.scriptPath}`);
  fs.mkdirSync(path.dirname(plan.plistPath), { recursive: true });
  fs.writeFileSync(plan.plistPath, plan.plist, { mode: 0o600 });
  fs.chmodSync(plan.plistPath, 0o600);

  launchctl(['bootout', `gui/${uid()}/${LAUNCHD_LABEL}`]);
  const boot = launchctl(['bootstrap', `gui/${uid()}`, plan.plistPath]);
  if (boot.status !== 0) {
    const legacy = launchctl(['load', '-w', plan.plistPath]);
    if (legacy.status !== 0) {
      throw new Error(`launchctl 加载失败：${(boot.stderr || legacy.stderr || '').trim()}`);
    }
  }
  return { dryRun: false, ...plan, wrote: true, loaded: true };
}

export function uninstall(config, opts = {}) {
  const home = opts.home || os.homedir();
  const file = plistPath(home);
  if (!opts.yes) return { dryRun: true, plistPath: file, removed: false };
  launchctl(['bootout', `gui/${uid()}/${LAUNCHD_LABEL}`]);
  let removed = false;
  try {
    fs.rmSync(file);
    removed = true;
  } catch {
    removed = false;
  }
  return { dryRun: false, plistPath: file, removed };
}

export function status(config, opts = {}) {
  const home = opts.home || os.homedir();
  const file = plistPath(home);
  const exists = fs.existsSync(file);
  let launchctlState = 'not-loaded';
  if (process.platform === 'darwin') {
    const r = launchctl(['print', `gui/${uid()}/${LAUNCHD_LABEL}`]);
    if (r.status === 0) {
      const m = String(r.stdout || '').match(/state = ([a-z-]+)/);
      launchctlState = m ? m[1] : 'loaded';
    } else {
      const list = launchctl(['list', LAUNCHD_LABEL]);
      launchctlState = list.status === 0 ? 'loaded(legacy)' : 'not-loaded';
    }
  }
  let nodeExists = null;
  if (exists) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const m = text.match(/<string>(\/[^<]*\/node)<\/string>/);
      nodeExists = m ? fs.existsSync(m[1]) : null;
    } catch {
      nodeExists = null;
    }
  }
  return { plistPath: file, plistExists: exists, launchctlState, nodeExists, nodePath: process.execPath };
}
