import { Outlet } from 'react-router-dom';
import LogoMark from './LogoMark';

export default function AdminLayout() {
  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f6f1e7_0%,#fbfaf7_42%,#eef2ed_100%)]">
      <div className="pointer-events-none fixed inset-x-0 top-0 -z-10 mx-auto h-[320px] w-[320px] rounded-full bg-moss/10 blur-3xl" />
      <header className="border-b border-ink/8 bg-white/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-4">
            <LogoMark />
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-moss/75">Private Admin</p>
              <p className="text-sm text-ink/70">Authorized users only</p>
            </div>
          </div>
        </div>
      </header>

      <main>
        <Outlet />
      </main>
    </div>
  );
}
