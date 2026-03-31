import { Outlet } from 'react-router-dom';
import Footer from './Footer';
import Header from './Header';

export default function Layout() {
  return (
    <div className="relative overflow-x-clip">
      <div className="pointer-events-none absolute left-[-6%] top-0 -z-10 h-[460px] w-[460px] rounded-full bg-clay/12 blur-3xl" />
      <div className="pointer-events-none absolute right-[-4%] top-[18%] -z-10 h-[420px] w-[420px] rounded-full bg-moss/12 blur-3xl" />
      <div className="pointer-events-none absolute inset-x-0 top-[14rem] -z-10 mx-auto h-[1px] w-[min(92%,72rem)] bg-gradient-to-r from-transparent via-line/70 to-transparent" />

      <Header />

      <main>
        <Outlet />
      </main>

      <Footer />
    </div>
  );
}
