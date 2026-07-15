import { Outlet } from 'react-router-dom';
import Footer from './Footer';
import Header from './Header';

export default function Layout() {
  return (
    <div className="relative overflow-x-clip">
      <a
        className="skip-link"
        href="#main-content"
      >
        Skip to content
      </a>
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-72 bg-[linear-gradient(180deg,rgba(255,255,255,0.58),rgba(255,255,255,0))]" />
      <div className="pointer-events-none absolute inset-x-0 top-[14rem] -z-10 mx-auto h-px w-[min(92%,72rem)] bg-gradient-to-r from-transparent via-line/70 to-transparent" />

      <Header />

      <main id="main-content" tabIndex={-1}>
        <Outlet />
      </main>

      <Footer />
    </div>
  );
}
