import { useEffect, useState } from 'react';
import { Users, UserPlus, Trash2, Loader2, Shield, User as UserIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { Navigate } from 'react-router-dom';

interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  created_at: string;
}

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  let password = '';
  // Ensure complexity: uppercase, lowercase, digit, special char
  password += 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)];
  password += 'abcdefghjkmnpqrstuvwxyz'[Math.floor(Math.random() * 23)];
  password += '23456789'[Math.floor(Math.random() * 8)];
  password += '!@#$%'[Math.floor(Math.random() * 5)];
  for (let i = 4; i < 12; i++) {
    password += chars[Math.floor(Math.random() * chars.length)];
  }
  // Shuffle
  return password.split('').sort(() => Math.random() - 0.5).join('');
}

function RoleBadge({ role }: { role: 'admin' | 'member' }) {
  if (role === 'admin') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-purple-100 dark:bg-purple-900/40 px-2.5 py-0.5 text-xs font-medium text-purple-700 dark:text-purple-300">
        <Shield className="h-3 w-3" />Admin
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 dark:bg-blue-900/40 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300">
      <UserIcon className="h-3 w-3" />Member
    </span>
  );
}

interface InviteModalProps {
  onClose: () => void;
  onCreated: () => void;
}

function InviteModal({ onClose, onCreated }: InviteModalProps) {
  const { toast } = useToast();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [password, setPassword] = useState(generatePassword());
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !name || !password) {
      toast({ title: 'Please fill in all fields', variant: 'destructive' });
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/auth/admin/create-user', { email, name, password, role });
      toast({ title: 'User created', description: `${email} can now log in.`, variant: 'success' });
      onCreated();
      onClose();
    } catch (err) {
      toast({
        title: 'Failed to create user',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    /* Overlay */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-background rounded-xl border shadow-lg w-full max-w-md mx-4 p-6">
        <h2 className="text-lg font-semibold mb-1">Invite User</h2>
        <p className="text-sm text-muted-foreground mb-5">
          Create a new account. Share the credentials securely with the user.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              placeholder="user@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-name">Full Name</Label>
            <Input
              id="invite-name"
              type="text"
              placeholder="Jane Smith"
              value={name}
              onChange={e => setName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-role">Role</Label>
            <Select value={role} onValueChange={v => setRole(v as 'admin' | 'member')}>
              <SelectTrigger id="invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Member</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-password">Temporary Password</Label>
            <div className="flex gap-2">
              <Input
                id="invite-password"
                type="text"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                className="font-mono text-sm"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPassword(generatePassword())}
                title="Generate new password"
              >
                ↺
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Share this password securely. The user can change it after logging in.</p>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Creating…</> : <>Create User</>}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function UsersPage() {
  const { user: currentUser } = useAuth();
  const { toast } = useToast();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Guard: only admins can access this page
  if (currentUser && currentUser.role !== 'admin') {
    return <Navigate to="/generate" replace />;
  }

  const fetchUsers = async () => {
    try {
      const data = await api.get<UserRecord[]>('/auth/users');
      setUsers(data);
    } catch {
      toast({ title: 'Failed to load users', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleDelete = async (u: UserRecord) => {
    if (u.id === currentUser?.id) return; // shouldn't happen — button is disabled
    if (!confirm(`Delete user "${u.email}"? This cannot be undone.`)) return;
    setDeletingId(u.id);
    try {
      await api.delete(`/auth/users/${u.id}`);
      setUsers(prev => prev.filter(x => x.id !== u.id));
      toast({ title: 'User deleted', description: u.email });
    } catch (err) {
      toast({
        title: 'Delete failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">User Management</h1>
          <p className="text-muted-foreground mt-1">
            {users.length} user{users.length !== 1 ? 's' : ''}
          </p>
        </div>
        <Button onClick={() => setShowInvite(true)}>
          <UserPlus className="mr-2 h-4 w-4" />Invite User
        </Button>
      </div>

      {/* Users Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />All Users
          </CardTitle>
          <CardDescription>Manage who has access to Genese Proposal AI.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : users.length === 0 ? (
            <p className="text-center text-muted-foreground py-12">No users found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Name</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Email</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Role</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Joined</th>
                    <th className="py-3 px-2" />
                  </tr>
                </thead>
                <tbody>
                  {users.map(u => {
                    const isSelf = u.id === currentUser?.id;
                    const isDeleting = deletingId === u.id;
                    return (
                      <tr key={u.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                        <td className="py-3 px-2 font-medium">
                          {u.name || '—'}
                          {isSelf && (
                            <span className="ml-2 text-[10px] text-muted-foreground">(you)</span>
                          )}
                        </td>
                        <td className="py-3 px-2 text-muted-foreground">{u.email}</td>
                        <td className="py-3 px-2">
                          <RoleBadge role={u.role} />
                        </td>
                        <td className="py-3 px-2 text-muted-foreground">
                          {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
                        </td>
                        <td className="py-3 px-2 text-right">
                          <span title={isSelf ? "You can't delete your own account" : undefined}>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={isSelf || isDeleting}
                              onClick={() => handleDelete(u)}
                              aria-label={`Delete ${u.email}`}
                              className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-40"
                            >
                              {isDeleting
                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                : <Trash2 className="h-4 w-4" />}
                            </Button>
                          </span>
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

      {/* Invite modal */}
      {showInvite && (
        <InviteModal
          onClose={() => setShowInvite(false)}
          onCreated={fetchUsers}
        />
      )}
    </div>
  );
}
