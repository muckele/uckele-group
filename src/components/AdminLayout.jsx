import { Outlet } from 'react-router-dom';
import LogoMark from './LogoMark';

export default function AdminLayout() {
  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f6f1e7_0%,#fbfaf7_42%,#eef2ed_100%)]">
      <a className="skip-link" href="#admin-main-content">
        Skip to admin content
      </a>
      <header className="border-b border-white/[0.70] bg-white/[0.76] backdrop-blur-2xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3 sm:gap-4">
            <LogoMark />
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-moss/75">Private Admin</p>
              <p className="text-sm text-ink/70">Authorized users only</p>
            </div>
          </div>
        </div>
      </header>

      <main id="admin-main-content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
