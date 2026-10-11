import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MonitorCog } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useTenantContext } from '@/hooks/useTenantContext';
import { hardware, isElectron } from '@/lib/hardware';
import { desktopAuthorization } from '@/lib/desktopAuthorization';
import { supabase } from '@/integrations/supabase/client';
import { translate as tx, useLanguageStore } from "@/i18n";

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
  useLanguageStore((state) => state.language); // re-render on language change
  const { tenantId, branches, hasRole } = useTenantContext();
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [channel, setChannel] = useState<'stable' | 'beta'>('stable');
  const [saving, setSaving] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [currentDeviceUid, setCurrentDeviceUid] = useState<string | null>(null);
  const [provisioned, setProvisioned] = useState<boolean | null>(null);
  const [activating, setActivating] = useState(false);
  const canManage = hasRole('owner', 'admin', 'manager');

  useEffect(() => {
    if (!hardware) return;
    Promise.all([hardware.getAppVersion(), hardware.getSettings(), hardware.getDeviceIdentity()])
      .then(([version, settings, identity]) => {
        setCurrentVersion(version);
        setChannel(settings.updateChannel);
        setCurrentDeviceUid(identity.deviceUid);
        setProvisioned(identity.provisioned);
      })
      .catch(() => undefined);
  }, []);

  const { data: devices = [], isLoading, refetch } = useQuery({
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
      await hardware.saveSettings({ updateChannel: channel }, await desktopAuthorization());
      toast.success(`Update channel changed to ${channel}. Restart ZAIPOS to apply it.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save update channel.');
    } finally {
      setSaving(false);
    }
  };

  // Enrol this computer for sales, cash and stock commands: an owner, admin or
  // manager approves this terminal's device id, and the desktop app exchanges
  // the approval for a credential kept in OS-encrypted storage.
  const activateThisTerminal = async () => {
    if (!hardware || !tenantId) return;
    setActivating(true);
    try {
      const authorization = await desktopAuthorization();
      const identity = await hardware.getDeviceIdentity();
      const { data: created, error } = await (supabase as any).rpc('approve_device_enrollment', {
        _tenant_id: authorization.tenantId,
        _branch_id: authorization.branchId,
        _device_uid: identity.deviceUid,
      });
      let approvalId: unknown = created;
      if (error) {
        // A previous attempt may have left an unused approval for this terminal; reuse it.
        const { data: pending } = await (supabase as any)
          .from('device_enrollment_approvals')
          .select('id')
          .eq('device_uid', identity.deviceUid)
          .is('consumed_at', null)
          .gt('expires_at', new Date().toISOString())
          .maybeSingle();
        approvalId = pending?.id;
      }
      if (typeof approvalId !== 'string') throw new Error(error?.message ?? 'Could not approve this terminal.');
      await hardware.activateDevice(approvalId, authorization);
      setProvisioned(true);
      toast.success('This terminal is activated for sales, cash and stock.');
      void refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not activate this terminal.');
    } finally {
      setActivating(false);
    }
  };

  const revokeDevice = async (device: DeviceRow) => {
    if (!tenantId || device.revoked_at) return;
    const confirmed = window.confirm(`Revoke terminal ${device.device_uid.slice(0, 12)}? It will immediately lose transaction authority.`);
    if (!confirmed) return;
    setRevokingId(device.id);
    try {
      if (hardware && currentDeviceUid === device.device_uid) {
        const result = await hardware.revokeDevice(device.id, await desktopAuthorization());
        toast.success(result.revoked
          ? 'This terminal was revoked and its local credential was erased.'
          : 'This terminal was already revoked; stale local credential state was erased.');
      } else {
        const { data, error } = await (supabase as any).rpc('revoke_device_enrollment', {
          _tenant_id: tenantId,
          _device_id: device.id,
          _reason: 'manager_console_revocation',
        });
        if (error) throw error;
        toast.success(data ? 'Terminal revoked.' : 'Terminal was already revoked.');
      }
      await refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not revoke terminal.');
    } finally {
      setRevokingId(null);
    }
  };

  if (!canManage) {
    return <p className="text-sm text-muted-foreground">{tx("Manager access is required to view terminal fleet state.")}</p>;
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MonitorCog className="h-4 w-4" /> {tx("This terminal")}
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
                <option value="stable">{tx("Stable")}</option>
                <option value="beta">{tx("Beta")}</option>
              </select>
            </label>
            <Button onClick={saveChannel} disabled={!isElectron() || saving}>
              {saving ? 'Saving…' : 'Save channel'}
            </Button>
          </div>
          {isElectron() && canManage && (
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant={provisioned ? 'default' : 'secondary'}>
                {provisioned ? 'Activated terminal' : 'Not activated'}
              </Badge>
              {!provisioned && (
                <Button onClick={activateThisTerminal} disabled={activating}>
                  {activating ? 'Activating…' : 'Activate this terminal'}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{tx("Registered terminals")}</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{tx("Loading terminals…")}</p>
          ) : devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tx("No Electron terminal has reported a heartbeat yet.")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="pb-2 pr-4">{tx("Terminal")}</th>
                    <th className="pb-2 pr-4">{tx("Branch")}</th>
                    <th className="pb-2 pr-4">{tx("Version")}</th>
                    <th className="pb-2 pr-4">{tx("Channel")}</th>
                    <th className="pb-2 pr-4">{tx("Last seen")}</th>
                    <th className="pb-2">{tx("State")}</th>
                    <th className="pb-2 pl-4 text-right">{tx("Action")}</th>
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
                        <td className="py-3 pl-4 text-right">
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={Boolean(device.revoked_at) || revokingId === device.id}
                            onClick={() => revokeDevice(device)}
                          >
                            {device.revoked_at ? 'Revoked' : revokingId === device.id ? 'Revoking…' : 'Revoke'}
                          </Button>
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
