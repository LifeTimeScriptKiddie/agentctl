import { z } from 'zod';

export const ADAPTER_CAPABILITY_NAMES = [
  'canReadFiles',
  'canWriteFiles',
  'canRunShell',
  'canAccessNetwork',
  'canUseBrowser',
  'canModifyRepo',
  'canPublish',
] as const;

export const AdapterCapabilityNameSchema = z.enum(ADAPTER_CAPABILITY_NAMES);
export type AdapterCapabilityName = z.infer<typeof AdapterCapabilityNameSchema>;

const CAPABILITY_BY_NORMALIZED_NAME = new Map<string, AdapterCapabilityName>(
  ADAPTER_CAPABILITY_NAMES.flatMap((name) => {
    const canonical = name.toLowerCase();
    const withoutCan = name.slice(3).toLowerCase();
    return [[canonical, name], [withoutCan, name]] as const;
  }),
);

/** Accept obvious planner aliases such as accessNetwork/access_network, but return canonical keys. */
export function normalizeCapabilityName(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const compact = value.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return CAPABILITY_BY_NORMALIZED_NAME.get(compact) ?? value;
}

export const CapabilityNeedSchema = z.preprocess(
  normalizeCapabilityName,
  AdapterCapabilityNameSchema,
);

/**
 * Capability labels per adapter. The controller/registry ENFORCES these
 * (they are not advisory): a read-only adapter is refused for a write role,
 * and Comet/browser is refused for any build/repair role.
 */
export const AdapterCapabilitiesSchema = z.object({
  canReadFiles: z.boolean().default(false),
  canWriteFiles: z.boolean().default(false),
  canRunShell: z.boolean().default(false),
  canAccessNetwork: z.boolean().default(false),
  canUseBrowser: z.boolean().default(false),
  canModifyRepo: z.boolean().default(false),
  canPublish: z.boolean().default(false),
});

export type AdapterCapabilities = z.infer<typeof AdapterCapabilitiesSchema>;

export const DEFAULT_CAPABILITIES: AdapterCapabilities = {
  canReadFiles: false,
  canWriteFiles: false,
  canRunShell: false,
  canAccessNetwork: false,
  canUseBrowser: false,
  canModifyRepo: false,
  canPublish: false,
};
