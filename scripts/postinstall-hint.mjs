#!/usr/bin/env node
/** Printed after npm install — keep non-interactive (CI-safe). */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const envHome = process.env.AGENTCTL_HOME;
const home = envHome ?? join(homedir(), '.agentctl');
const prefsPath = join(home, 'preferences.yaml');
const ephemeral =
  !!envHome
  && (/\/tmp\//.test(envHome.replace(/\\/g, '/'))
    || /\/var\/folders\//.test(envHome.replace(/\\/g, '/'))
    || /agentctl-setup(?:-test)?-/.test(envHome));

if (ephemeral) {
  console.log(`
agentctl: warning: AGENTCTL_HOME=${envHome} looks like a leftover test directory.
  unset AGENTCTL_HOME
  then run: agentctl setup --auto
`);
} else if (!existsSync(prefsPath)) {
  console.log(`
agentctl: no preferences yet at ${prefsPath}

  agentctl setup          # interactive (TTY)
  agentctl setup --auto   # probe PATH and optimize defaults
  agentctl setup --show   # inspect what would be used
`);
} else {
  console.log(`
agentctl: preferences ok (${prefsPath})
  agentctl setup --show   # inspect
  agentctl setup --auto   # re-probe and rewrite
`);
}
