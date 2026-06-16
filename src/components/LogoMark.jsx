export default function LogoMark({ light = false }) {
  const textColor = light ? 'text-white' : 'text-ink';
  const subColor = light ? 'text-white/70' : 'text-moss';

  return (
    <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
      <svg aria-hidden="true" className="h-10 w-10 shrink-0 sm:h-11 sm:w-11" viewBox="0 0 72 72">
        <rect fill={light ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.55)'} height="72" rx="18" width="72" />
        <path d="M18 14H31V43L45 57H31L18 44V14Z" fill={light ? '#FFFFFF' : '#18211D'} />
        <path d="M40 14H53V43L40 57L33 50L40 43V14Z" fill={light ? '#D8E4DD' : '#173126'} />
      </svg>

      <div className="min-w-0 leading-none">
        <span className={`block text-sm font-extrabold uppercase tracking-[0.18em] sm:text-base sm:tracking-[0.24em] ${textColor}`}>Uckele</span>
        <span className={`block pt-1 text-[9px] font-semibold uppercase tracking-[0.32em] sm:text-[10px] sm:tracking-[0.42em] ${subColor}`}>Group</span>
      </div>
    </div>
  );
}
