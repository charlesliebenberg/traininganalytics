import { useState } from 'react';
import { Activity, Lock } from 'lucide-react';
import { http, queryClient } from '../lib/api';
import { Button, Input } from '../components/ui';

export function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await http('/session/login', { method: 'POST', json: { password } });
      await queryClient.invalidateQueries();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form onSubmit={submit} className="card w-full max-w-sm p-7">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-white">
            <Activity className="h-5 w-5" strokeWidth={2.5} />
          </div>
          <div>
            <div className="text-[15px] font-semibold">Training Analytics</div>
            <div className="text-xs text-muted">Enter your password to continue</div>
          </div>
        </div>
        <div className="relative">
          <Lock className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-muted" />
          <Input type="password" autoFocus autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full pl-9" />
        </div>
        {error && <p className="mt-2 text-xs text-critical">{error}</p>}
        <Button type="submit" variant="primary" className="mt-4 w-full" loading={busy} disabled={!password}>
          Sign in
        </Button>
      </form>
    </div>
  );
}
