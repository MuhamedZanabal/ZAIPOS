import { useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { hardware, isElectron } from '@/lib/hardware';
import { getDeviceId } from '@/lib/deviceIdentity';
import { useAuth } from '@/hooks/useAuth';
import { useTenantStore } from '@/stores/tenant';

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export async function registerDeviceHeartbeat(tenantId: string, branchId: string): Promise<void> {
  if (!isElectron() || !hardware) return;

  const [appVersion, settings] = await Promise.all([
    hardware.getAppVersion(),
    hardware.getSettings(),
  ]);

  const { error } = await supabase.rpc('register_device_heartbeat', {
    _tenant_id: tenantId,
    _branch_id: branchId,
    _device_uid: getDeviceId(),
    _app_version: appVersion,
    _os: hardware.platform,
    _update_channel: settings.updateChannel,
    _update_state: 'current',
    _capabilities: {
      kiosk: settings.kiosk,
      printer: settings.printer.connectionType,
      barcode: settings.barcode.mode,
    },
  });

  if (error) throw error;
}

export function useDeviceHeartbeat(): void {
  const { user } = useAuth();
  const tenantId = useTenantStore((state) => state.tenantId);
  const branchId = useTenantStore((state) => state.branchId);

  useEffect(() => {
    if (!user || !tenantId || !branchId || !isElectron()) return;

    let active = true;
    const report = () => {
      if (!active) return;
      registerDeviceHeartbeat(tenantId, branchId).catch((error) => {
        console.warn('[Device] Heartbeat failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    };

    report();
    const timer = window.setInterval(report, HEARTBEAT_INTERVAL_MS);
    window.addEventListener('online', report);

    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('online', report);
    };
  }, [branchId, tenantId, user]);
}
