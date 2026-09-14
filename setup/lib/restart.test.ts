import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    const pidFile = path.join(root, 'fixture.pid');
    if (fs.existsSync(pidFile)) {
      try {
        process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
      } catch {
        // The fixture listener already exited.
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe.runIf(process.platform !== 'win32')('restart helper', () => {
  it('uses the nohup launcher when systemd cannot restart the install', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-restart-'));
    roots.push(root);
    const lib = path.join(root, 'setup', 'lib');
    const bin = path.join(root, 'fixture-bin');
    fs.mkdirSync(lib, { recursive: true });
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(root, 'data'));
    fs.copyFileSync(new URL('./restart.sh', import.meta.url), path.join(lib, 'restart.sh'));
    fs.copyFileSync(new URL('./install-slug.sh', import.meta.url), path.join(lib, 'install-slug.sh'));

    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(
      path.join(root, 'start-nanoclaw.sh'),
      `#!/bin/bash\nset -e\ntouch ${JSON.stringify(path.join(root, 'launcher-ran'))}\n${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        "const fs=require('fs');const net=require('net');const p=process.argv[1];try{fs.unlinkSync(p)}catch{};net.createServer(()=>{}).listen(p);",
      )} ${JSON.stringify(path.join(root, 'data', 'ncl.sock'))} </dev/null >/dev/null 2>&1 &\necho $! > ${JSON.stringify(path.join(root, 'fixture.pid'))}\n`,
      { mode: 0o755 },
    );

    execFileSync('/bin/bash', [path.join(lib, 'restart.sh')], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      stdio: 'pipe',
      timeout: 5000,
    });

    expect(fs.existsSync(path.join(root, 'launcher-ran'))).toBe(true);
    expect(fs.statSync(path.join(root, 'data', 'ncl.sock')).isSocket()).toBe(true);
  });
});
