import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MonitorCog } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useTenantContext } from '@/hooks/useTenantContext';
import { hardware, isElectron } from '@/lib/hardware';
import { supabase } from '@/integrations/supabase/client';

type DeviceRow = {
  id: string;
  branch_id: string | null;
  device_uid: string;
  app_version: string;
  os: string;
  update_channel: 'stable' | 'beta';
  update_state: string;
  last_seen_at: string;
  revoked_at: string | null;
};

export default function DevicesSettings() {
  const { tenantId, branches, hasRole } = useTenantContext();
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [channel, setChannel] = useState<'stable' | 'beta'>('stable');
  const [saving, setSaving] = useState(false);
  const canManage = hasRole('owner', 'admin', 'manager');

  useEffect(() => {
    if (!hardware) return;
    Promise.all([hardware.getAppVersion(), hardware.getSettings()])
      .then(([version, settings]) => {
        setCurrentVersion(version);
        setChannel(settings.updateChannel);
      })
      .catch(() => undefined);
  }, []);

  const { data: devices = [], isLoading } = useQuery({
    queryKey: ['devices', tenantId],
    enabled: Boolean(tenantId && canManage),
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('devices')
        .select('id, branch_id, device_uid, app_version, os, update_channel, update_state, last_seen_at, revoked_at')
        .eq('tenant_id', tenantId)
        .order('last_seen_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as DeviceRow[];
    },
  });

  const saveChannel = async () => {
    if (!hardware) return;
    setSaving(true);
    try {
      await hardware.saveSettings({ updateChannel: channel });
      toast.success(`Update channel changed to ${channel}. Restart ZAIPOS to apply it.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save update channel.');
    } finally {
      setSaving(false);
    }
  };

  if (!canManage) {
    return <p className="text-sm text-muted-foreground">Manager access is required to view terminal fleet state.</p>;
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MonitorCog className="h-4 w-4" /> This terminal
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Version {currentVersion ?? 'Web'} · updates require operator approval before download and installation.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1 text-sm">
              <span className="block text-xs text-muted-foreground">Update channel</span>
              <select
                className="h-9 rounded-md border bg-background px-3"
                value={channel}
                onChange={(event) => setChannel(event.target.value as 'stable' | 'beta')}
                disabled={!isElectron()}
              >
                <option value="stable">Stable</option>
                <option value="beta">Beta</option>
              </select>
            </label>
            <Button onClick={saveChannel} disabled={!isElectron() || saving}>
              {saving ? 'Saving…' : 'Save channel'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Registered terminals</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading terminals…</p>
          ) : devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Electron terminal has reported a heartbeat yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="pb-2 pr-4">Terminal</th>
                    <th className="pb-2 pr-4">Branch</th>
                    <th className="pb-2 pr-4">Version</th>
                    <th className="pb-2 pr-4">Channel</th>
                    <th className="pb-2 pr-4">Last seen</th>
                    <th className="pb-2">State</th>
                  </tr>
                </thead>
                <tbody>
                  {devices.map((device) => {
                    const versionDiffers = Boolean(currentVersion && device.app_version !== currentVersion);
                    const state = device.revoked_at ? 'revoked' : versionDiffers ? 'outdated' : device.update_state;
                    return (
                      <tr key={device.id} className="border-t">
                        <td className="py-3 pr-4 font-mono text-xs" title={device.device_uid}>
                          {device.device_uid.slice(0, 12)}
                        </td>
                        <td className="py-3 pr-4">
                          {branches.find((branch) => branch.id === device.branch_id)?.name ?? 'Tenant-wide'}
                        </td>
                        <td className="py-3 pr-4">{device.app_version} · {device.os}</td>
                        <td className="py-3 pr-4 capitalize">{device.update_channel}</td>
                        <td className="py-3 pr-4">{new Date(device.last_seen_at).toLocaleString('en-BH')}</td>
                        <td className="py-3">
                          <Badge variant={state === 'current' ? 'secondary' : 'destructive'}>{state}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
