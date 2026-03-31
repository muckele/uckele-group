import { Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { navigation } from '../content/siteContent';
import ButtonLink from './ButtonLink';
import LogoMark from './LogoMark';

function navLinkClass({ isActive }) {
  return `text-sm font-medium transition ${isActive ? 'text-moss' : 'text-ink/72 hover:text-ink'}`;
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
    <header className="sticky top-0 z-50 px-4 pt-4 sm:px-6 lg:px-8">
      <div
        className={`mx-auto max-w-7xl rounded-full border transition duration-300 ${
          scrolled ? 'border-line bg-white/88 shadow-lg shadow-ink/5 backdrop-blur-xl' : 'border-white/55 bg-white/70 backdrop-blur'
        }`}
      >
        <div className="flex items-center justify-between gap-5 px-5 py-3 sm:px-6">
          <Link aria-label="Uckele Group home" to="/">
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
            className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-ink/10 bg-white/70 text-ink transition hover:border-moss/25 hover:text-moss lg:hidden"
            onClick={() => setMenuOpen((current) => !current)}
            type="button"
          >
            {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      <div
        className={`mx-auto mt-3 max-w-7xl overflow-hidden rounded-[28px] border border-line bg-white/95 shadow-panel backdrop-blur transition duration-300 lg:hidden ${
          menuOpen ? 'pointer-events-auto max-h-[520px] opacity-100' : 'pointer-events-none max-h-0 opacity-0'
        }`}
      >
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
    </header>
  );
}
