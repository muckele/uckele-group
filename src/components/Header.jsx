import { Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { navigation } from '../content/siteContent';
import ButtonLink from './ButtonLink';
import LogoMark from './LogoMark';

function navLinkClass({ isActive }) {
  return `rounded-full px-3 py-2 text-sm font-medium transition ${
    isActive
      ? 'bg-white/[0.82] text-moss shadow-[0_12px_24px_rgba(24,33,29,0.06)]'
      : 'text-ink/70 hover:bg-white/[0.65] hover:text-ink'
  }`;
}

export default function Header() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    function handleScroll() {
      setScrolled(window.scrollY > 10);
    }

    handleScroll();
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <header className="sticky top-0 z-50 px-3 pt-3 sm:px-6 sm:pt-4 lg:px-8">
      <div
        className={`mx-auto max-w-7xl rounded-2xl border transition duration-300 sm:rounded-[24px] ${
          scrolled
            ? 'border-white/[0.85] bg-white/[0.84] shadow-[0_24px_55px_rgba(24,33,29,0.12)] backdrop-blur-2xl'
            : 'border-white/[0.70] bg-white/[0.66] shadow-[0_18px_42px_rgba(24,33,29,0.06)] backdrop-blur-xl'
        }`}
      >
        <div className="flex items-center justify-between gap-3 px-3.5 py-3 sm:gap-5 sm:px-6 sm:py-3.5">
          <Link aria-label="Uckele Group home" className="min-w-0" to="/">
            <LogoMark />
          </Link>

          <nav aria-label="Primary navigation" className="hidden items-center gap-7 lg:flex">
            {navigation.map((item) => (
              <NavLink key={item.path} className={navLinkClass} to={item.path}>
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="hidden lg:block">
            <ButtonLink href="/contact">Start A Conversation</ButtonLink>
          </div>

          <button
            aria-expanded={menuOpen}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/[0.80] bg-white/[0.78] text-ink shadow-[0_14px_26px_rgba(24,33,29,0.06)] transition hover:border-moss/18 hover:text-moss lg:hidden"
            onClick={() => setMenuOpen((current) => !current)}
            type="button"
          >
            {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {menuOpen ? (
        <div className="pointer-events-auto mx-auto mt-3 max-h-[calc(100vh-6.5rem)] max-w-7xl overflow-y-auto rounded-2xl border border-white/[0.80] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(248,244,237,0.94))] opacity-100 shadow-panel backdrop-blur-xl transition duration-300 sm:rounded-[24px] lg:hidden">
          <div className="grid gap-1 p-4">
            {navigation.map((item) => (
              <NavLink
                key={item.path}
                className={({ isActive }) =>
                  `rounded-2xl px-4 py-3 text-sm font-medium transition ${
                    isActive ? 'bg-moss text-white' : 'text-ink/75 hover:bg-fog hover:text-ink'
                  }`
                }
                to={item.path}
              >
                {item.label}
              </NavLink>
            ))}

            <ButtonLink className="mt-3" href="/contact">
              Start A Conversation
            </ButtonLink>
          </div>
        </div>
      ) : null}
    </header>
  );
}
