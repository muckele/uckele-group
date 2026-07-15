import { Outlet } from 'react-router-dom';
import LogoMark from './LogoMark';

export default function AdminLayout() {
  return (
    <div className="admin-app">
      <a className="skip-link" href="#admin-main-content">
        Skip to admin content
      </a>
      <header className="admin-topbar">
        <div className="admin-topbar-inner">
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
