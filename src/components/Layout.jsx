import { Outlet } from 'react-router-dom';
import Footer from './Footer';
import Header from './Header';

export default function Layout() {
  return (
    <div className="relative overflow-x-clip">
      <div className="pointer-events-none absolute left-0 top-0 -z-10 h-[420px] w-[420px] rounded-full bg-clay/10 blur-3xl" />
      <div className="pointer-events-none absolute right-0 top-[20%] -z-10 h-[380px] w-[380px] rounded-full bg-moss/10 blur-3xl" />

      <Header />

      <main>
        <Outlet />
      </main>

      <Footer />
    </div>
  );
}
