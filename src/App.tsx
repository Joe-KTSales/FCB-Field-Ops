import { lazy, Suspense, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import Layout from '@/components/Layout';
import Login from '@/pages/Login';
import { Button, ErrorBox, Field, Spinner, inputCls } from '@/components/ui';

const Dispatch = lazy(() => import('@/pages/Dispatch'));
const Week = lazy(() => import('@/pages/Week'));
const WorkOrders = lazy(() => import('@/pages/WorkOrders'));
const WorkOrderDetail = lazy(() => import('@/pages/WorkOrderDetail'));
const Jobs = lazy(() => import('@/pages/Jobs'));
const JobFolder = lazy(() => import('@/pages/JobFolder'));
const Customer = lazy(() => import('@/pages/Customer'));
const Intake = lazy(() => import('@/pages/Intake'));
const PWReport = lazy(() => import('@/pages/PWReport'));
const Crews = lazy(() => import('@/pages/Crews'));
const Admin = lazy(() => import('@/pages/Admin'));

function SetPassword({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-h-screen items-center justify-center bg-navy p-4">
      <form
        className="flex w-full max-w-sm flex-col gap-4 rounded-xl bg-white p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const { error } = await supabase.auth.updateUser({ password: pw });
          setBusy(false);
          if (error) return setErr(error);
          sessionStorage.removeItem('fcb-set-password');
          onDone();
        }}
      >
        <h1 className="text-xl font-bold">Welcome — set your password</h1>
        <Field label="New password" hint="At least 8 characters">
          <input className={inputCls} type="password" minLength={8} required autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <ErrorBox error={err} />
        <Button variant="primary" disabled={busy}>Save password</Button>
      </form>
    </div>
  );
}

export default function App() {
  const { session, loading, role, profile } = useAuth();
  const [needPw, setNeedPw] = useState(() => sessionStorage.getItem('fcb-set-password') === '1');

  if (loading) return <Spinner label="Loading Field Ops…" />;
  if (!session) return <Login />;
  if (needPw) return <SetPassword onDone={() => setNeedPw(false)} />;
  if (!role) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-center">
        <div className="max-w-md">
          <h1 className="text-xl font-bold">Account not active</h1>
          <p className="mt-2 text-slate-600">
            {profile ? 'Your account is turned off.' : 'Your account has no profile yet.'} Ask an admin to set your role.
          </p>
          <Button className="mt-4" onClick={() => supabase.auth.signOut()}>Sign out</Button>
        </div>
      </div>
    );
  }

  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dispatch />} />
          <Route path="week" element={<Week />} />
          <Route path="work-orders" element={<WorkOrders />} />
          <Route path="work-orders/:id" element={<WorkOrderDetail />} />
          <Route path="jobs" element={<Jobs />} />
          <Route path="jobs/:id" element={<JobFolder />} />
          <Route path="customers/:id" element={<Customer />} />
          <Route path="intake" element={<Intake />} />
          <Route path="pw" element={<PWReport />} />
          <Route path="crews" element={<Crews />} />
          <Route path="admin" element={<Admin />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
