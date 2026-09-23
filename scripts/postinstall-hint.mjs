#!/usr/bin/env node
/** Printed after npm install — keep non-interactive (CI-safe). */
console.log(`
agentctl: next step — choose models for the agents on this machine:

  agentctl setup          # interactive (TTY)
  agentctl setup --auto   # probe PATH and optimize defaults
  agentctl setup --show   # inspect what would be used

Preferences are saved to ~/.agentctl/preferences.yaml
`);
