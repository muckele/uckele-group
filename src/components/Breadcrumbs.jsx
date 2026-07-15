import { ChevronRight } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { breadcrumbLabels } from '../content/structuredData';

export default function Breadcrumbs() {
  const { pathname } = useLocation();
  const label = breadcrumbLabels[pathname];

  if (!label) return null;

  return (
    <nav aria-label="Breadcrumb" className="section-shell pt-5 sm:pt-7">
      <ol className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-ink/52">
        <li><Link className="transition hover:text-moss" to="/">Home</Link></li>
        <li aria-hidden="true"><ChevronRight className="h-3.5 w-3.5" /></li>
        <li aria-current="page" className="text-moss">{label}</li>
      </ol>
    </nav>
  );
}
