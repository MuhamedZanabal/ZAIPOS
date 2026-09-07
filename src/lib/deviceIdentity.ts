const DEVICE_ID_KEY = 'zaipos_device_id';
const LEGACY_DEVICE_ID_KEY = 'poss360t_device_id';

export function getDeviceId(): string {
  const current = window.localStorage.getItem(DEVICE_ID_KEY);
  if (current) return current;

  const legacy = window.localStorage.getItem(LEGACY_DEVICE_ID_KEY);
  const deviceId = legacy || crypto.randomUUID();
  window.localStorage.setItem(DEVICE_ID_KEY, deviceId);
  return deviceId;
}
