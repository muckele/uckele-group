import React from 'react';
import { pursueNextActionPresentation } from './brokerMaterialsPresentation.js';

export default function PursueNextAction(props) {
  const action = pursueNextActionPresentation(props);
  return (
    <section aria-label="Pursue next action" className="rounded-xl border border-sky-200 bg-sky-50/70 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-sky-800">{action.kind}</p>
      <h4 className="mt-1 text-sm font-semibold text-sky-950">{action.title}</h4>
      <p className="mt-1 text-sm leading-6 text-sky-900">{action.detail}</p>
      <p className="mt-2 text-xs text-sky-800/75">Guidance only: this status card does not send or create work.</p>
    </section>
  );
}
