import { useState } from 'react';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { Button, ErrorBox, Field, inputCls } from '@/components/ui';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'password' | 'link'>('password');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (mode === 'password') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { shouldCreateUser: false, emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        setSent(true);
      }
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-navy p-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-2xl">
        <div className="mb-5 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-brand text-sm font-bold text-white">FCB</span>
          <div>
            <h1 className="text-xl font-bold">Field Ops</h1>
            <p className="text-sm text-slate-600">Fiber Care Baths · KT Sales &amp; Service</p>
          </div>
        </div>
        {!supabaseConfigured && (
          <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            The app isn’t connected to Supabase yet. Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in Vercel, then redeploy.
          </div>
        )}
        {sent ? (
          <p className="text-sm">Check <b>{email}</b> for a sign-in link.</p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field label="Email">
              <input className={inputCls} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            {mode === 'password' && (
              <Field label="Password">
                <input className={inputCls} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
            )}
            <ErrorBox error={err} />
            <Button variant="primary" disabled={busy} type="submit">
              {busy ? 'Signing in…' : mode === 'password' ? 'Sign in' : 'Email me a sign-in link'}
            </Button>
            <button type="button" className="text-sm text-brand-dark underline" onClick={() => setMode(mode === 'password' ? 'link' : 'password')}>
              {mode === 'password' ? 'Use an email link instead' : 'Use a password instead'}
            </button>
          </form>
        )}
        <p className="mt-5 text-xs text-slate-500">Access is by invitation. Ask an admin if you need an account.</p>
      </div>
    </div>
  );
}
