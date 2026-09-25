export interface DeviceKeyMaterial {
  privateKeyPem: string;
  certificateRef: string;
}

/** Renderer-visible identity. The private key never leaves the main process. */
export function preloadDeviceIdentity(material: DeviceKeyMaterial): { certificateRef: string } {
  if (!material.certificateRef || material.certificateRef.includes('PRIVATE')) {
    throw new Error('LOCAL_PROFILE_INVALID');
  }
  return { certificateRef: material.certificateRef };
}

export const LOCAL_PRELOAD_METHODS = ['localStatus', 'enrollLocalTerminal', 'localRequest', 'subscribeLocalEvents'] as const;
