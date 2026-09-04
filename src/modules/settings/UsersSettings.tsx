import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { useAuth } from "@/hooks/useAuth";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/EmptyState";
import { Users, Trash2, UserPlus, KeyRound } from "lucide-react";
import { toast } from "sonner";
import type { Database } from "@/integrations/supabase/types";
import { MANAGEABLE_ROLES, ROLE_LABEL } from "@/lib/roles";

type AppRolee = Database["public"]["Enums"]["app_role"];
const ROLES = MANAGEABLE_ROLES;

type Membership = {
  id: string;
  user_id: string;
  role: AppRolee;
  branch_id: string | null;
  profile: { email: string | null; full_name: string | null } | null;
};

export default function UsersSettings() {
  const { tenantId, branches, hasRolee } = useTenantContext();
  const { user } = useAuth();
  const qc = useQueryClient();
  const canManage = hasRolee("owner", "admin");

  // Invite (existing user)
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRolee, setInviteRolee] = useState<AppRolee>("waiter");
  const [inviteBranch, setInviteBranch] = useState<string>("__all__");
  const [inviting, setInviting] = useState(false);

  // Create (new user)
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newName, setNewName] = useState("");
  const [newRolee, setNewRolee] = useState<AppRolee>("waiter");
  const [newBranch, setNewBranch] = useState<string>("__all__");
  const [creating, setCreating] = useState(false);

  const { data: memberships, isLoading } = useQuery({
    queryKey: ["tenant-members", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data: roles, error } = await supabase
        .from("user_roles")
        .select("id, user_id, role, branch_id")
        .eq("tenant_id", tenantId!);
      if (error) throw error;
      const userIds = Array.from(new Set((roles ?? []).map((r) => r.user_id)));
      const profilesMap = new Map<string, { email: string | null; full_name: string | null }>();
      if (userIds.length > 0) {
        const { data: profiles } = await supabase
          .from("profiles")
          .select("id, email, full_name")
          .in("id", userIds);
        (profiles ?? []).forEach((p) =>
          profilesMap.set(p.id, { email: p.email, full_name: p.full_name }),
        );
      }
      return (roles ?? []).map((r) => ({
        ...r,
        profile: profilesMap.get(r.user_id) ?? null,
      })) as Membership[];
    },
  });

  const ownersCount = (memberships ?? []).filter((m) => m.role === "owner").length;

  const changeRolee = async (m: Membership, newRoleeVal: AppRolee) => {
    if (m.role === newRoleeVal) return;
    if (m.role === "owner" && newRoleeVal !== "owner" && ownersCount <= 1) {
      return toast.error("There must be at least one owner in the business");
    }
    const { error } = await supabase
      .from("user_roles")
      .update({ role: newRoleeVal })
      .eq("id", m.id);
    if (error) return toast.error(error.message);
    toast.success("Rolee updated");
    qc.invalidateQueries({ queryKey: ["tenant-members"] });
  };

  const changeBranch = async (m: Membership, branchId: string | null) => {
    const { error } = await supabase
      .from("user_roles")
      .update({ branch_id: branchId })
      .eq("id", m.id);
    if (error) return toast.error(error.message);
    toast.success("Branch updated");
    qc.invalidateQueries({ queryKey: ["tenant-members"] });
  };

  const removeMember = async (m: Membership) => {
    if (m.user_id === user?.id) {
      return toast.error("You cannot remove your own access");
    }
    if (m.role === "owner" && ownersCount <= 1) {
      return toast.error("There must be at least one owner in the business");
    }
    if (!confirm(`Remove access for ${m.profile?.email ?? "this user"}?`)) return;
    const { error } = await supabase.from("user_roles").delete().eq("id", m.id);
    if (error) return toast.error(error.message);
    toast.success("Acceso revocado");
    qc.invalidateQueries({ queryKey: ["tenant-members"] });
  };

  const invite = async () => {
    if (!tenantId) return;
    const email = inviteEmail.trim().toLowerCase();
    if (!email) return toast.error("Enter an email");
    setInviting(true);
    try {
      const { data: profile, error: pErr } = await supabase
        .from("profiles")
        .select("id, email")
        .ilike("email", email)
        .maybeSingle();
      if (pErr) throw pErr;
      if (!profile) {
        toast.error("That user does not exist yet. Use the 'Create new' tab to register them.");
        return;
      }
      const { data: existing } = await supabase
        .from("user_roles")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("user_id", profile.id)
        .eq("role", inviteRolee)
        .maybeSingle();
      if (existing) {
        toast.error("That user already has this role assigned");
        return;
      }
      const { error: insErr } = await supabase
        .from("user_roles")
        .insert({
          tenant_id: tenantId,
          user_id: profile.id,
          role: inviteRolee,
          branch_id: inviteBranch === "__all__" ? null : inviteBranch,
        });
      if (insErr) throw insErr;
      toast.success("User added to business");
      setInviteEmail("");
      qc.invalidateQueries({ queryKey: ["tenant-members"] });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setInviting(false);
    }
  };

  const createNew = async () => {
    if (!tenantId) return;
    if (!newEmail.trim() || newPassword.length < 6) {
      return toast.error("Email and password (minimum 6 characters) are required");
    }
    setCreating(true);
    try {
      const { data, error } = await supabase.functions.invoke("create-user", {
        body: {
          email: newEmail.trim().toLowerCase(),
          password: newPassword,
          full_name: newName.trim() || newEmail.trim(),
          role: newRolee,
          tenant_id: tenantId,
          branch_id: newBranch === "__all__" ? null : newBranch,
        },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success(`User ${newEmail} created. Share the password with them.`);
      setNewEmail("");
      setNewPassword("");
      setNewName("");
      qc.invalidateQueries({ queryKey: ["tenant-members"] });
    } catch (e: any) {
      toast.error(e.message ?? "Could not create the user");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      {canManage && (
        <div className="glass p-5 rounded-2xl space-y-4">
          <div className="flex items-center gap-2">
            <span className="orb orb-sq w-8 h-8">
              <UserPlus className="h-4 w-4" />
            </span>
            <h3 className="font-semibold text-ink-900">Add user to business</h3>
          </div>

          <Tabs defaultValue="create">
            <TabsList>
              <TabsTrigger value="create">Create new</TabsTrigger>
              <TabsTrigger value="invite">Invitar existente</TabsTrigger>
            </TabsList>

            <TabsContent value="create" className="mt-4 space-y-3">
              <p className="h-meta">
                Create the account and assign the role in one step. Share the email and password with the user.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Name</Label>
                  <Input
                    placeholder="John Smith"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Email</Label>
                  <Input
                    type="email"
                    placeholder="user@email.com"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Password</Label>
                  <Input
                    type="text"
                    placeholder="Minimum 6 characters"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Role</Label>
                  <Select value={newRolee} onValueChange={(v) => setNewRolee(v as AppRolee)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ROLES.map((r) => (
                        <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Branch</Label>
                  <Select value={newBranch} onValueChange={setNewBranch}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">All branches</SelectItem>
                      {branches.map((b) => (
                        <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <button type="button" className="g-btn g-btn-primary" onClick={createNew} disabled={creating}>
                <KeyRound className="h-4 w-4" />
                {creating ? "Creating…" : "Create user"}
              </button>
            </TabsContent>

            <TabsContent value="invite" className="mt-4 space-y-3">
              <p className="h-meta">
                If the user already has an account in another business in the system, search by email to assign a role here.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-[1fr_180px_180px_auto] gap-3 items-end">
                <div className="space-y-1.5">
                  <Label>Email</Label>
                  <Input
                    type="email"
                    placeholder="user@email.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Role</Label>
                  <Select value={inviteRolee} onValueChange={(v) => setInviteRolee(v as AppRolee)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ROLES.map((r) => (
                        <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Branch</Label>
                  <Select value={inviteBranch} onValueChange={setInviteBranch}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">All</SelectItem>
                      {branches.map((b) => (
                        <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <button type="button" className="g-btn g-btn-primary" onClick={invite} disabled={inviting}>
                  {inviting ? "Adding…" : "Add"}
                </button>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      )}

      <div className="glass rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-black/5">
          <p className="font-semibold text-ink-900">Miembros del bar</p>
          <p className="h-meta">
            {memberships?.length ?? 0} {(memberships?.length ?? 0) === 1 ? "user" : "users"} with access
          </p>
        </div>
        {isLoading ? (
          <div className="h-meta py-12 text-center">Loading…</div>
        ) : !memberships || memberships.length === 0 ? (
          <div className="p-6">
            <EmptyState icon={Users} title="No users" description="There are no members in this business yet" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-black/5">
                  <th className="text-left px-5 py-3 h-label">User</th>
                  <th className="text-left px-5 py-3 h-label">Role</th>
                  <th className="text-left px-5 py-3 h-label">Branch</th>
                  {canManage && <th className="w-12 px-5 py-3 sr-only">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {memberships.map((m) => {
                  const isSelf = m.user_id === user?.id;
                  return (
                    <tr key={m.id} className="border-b border-black/5 last:border-0">
                      <td className="px-5 py-3">
                        <div className="font-medium flex items-center gap-2 text-ink-900">
                          {m.profile?.full_name || m.profile?.email || m.user_id.slice(0, 8)}
                          {isSelf && (
                            <span className="g-pill g-pill-brand g-pill-h20">You</span>
                          )}
                        </div>
                        {m.profile?.email && (
                          <div className="h-meta">{m.profile.email}</div>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        {canManage && m.role !== "super_admin" ? (
                          <Select
                            value={m.role}
                            onValueChange={(v) => changeRolee(m, v as AppRolee)}
                          >
                            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {ROLES.map((r) => (
                                <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className={`g-pill ${m.role === "super_admin" ? "g-pill-brand" : "g-pill-ghost"} g-pill-h22`}>
                            {ROLE_LABEL[m.role] || m.role}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        {canManage ? (
                          <Select
                            value={m.branch_id ?? "all"}
                            onValueChange={(v) => changeBranch(m, v === "all" ? null : v)}
                          >
                            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="all">All branches</SelectItem>
                              {branches.map((b) => (
                                <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="h-meta">
                            {branches.find((b) => b.id === m.branch_id)?.name ?? "All"}
                          </span>
                        )}
                      </td>
                      {canManage && (
                        <td className="px-5 py-3">
                          <button
                            type="button"
                            className="g-btn g-btn-ghost h-8 w-8 p-0 flex items-center justify-center text-red-500 hover:text-red-600"
                            onClick={() => removeMember(m)}
                            disabled={isSelf || m.role === "super_admin"}
                            title={
                              isSelf
                                ? "No puedes eliminarte"
                                : m.role === "super_admin"
                                ? "No puedes quitar un super admin"
                                : "Quitar acceso"
                            }
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
