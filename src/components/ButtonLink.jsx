import { Link } from 'react-router-dom';

function getVariantClasses(variant) {
  if (variant === 'secondary') {
    return 'border border-white/[0.85] bg-white/[0.78] text-ink shadow-[0_18px_34px_rgba(24,33,29,0.08)] hover:-translate-y-0.5 hover:border-moss/18 hover:bg-white';
  }

  if (variant === 'ghost') {
    return 'border border-transparent bg-transparent text-ink hover:-translate-y-0.5 hover:border-white/[0.75] hover:bg-white/60';
  }

  return 'border border-pine/90 bg-[linear-gradient(135deg,#173126_0%,#284638_52%,#315444_100%)] text-white shadow-[0_18px_38px_rgba(23,49,38,0.24)] hover:-translate-y-0.5 hover:border-pine hover:shadow-[0_24px_48px_rgba(23,49,38,0.28)]';
}

export default function ButtonLink({ href, children, variant = 'primary', className = '', ...props }) {
  const classes = `inline-flex min-h-[48px] items-center justify-center gap-2 rounded-full px-5 py-3.5 text-sm font-semibold tracking-[0.01em] transition duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss/25 ${getVariantClasses(
    variant,
  )} ${className}`;

  if (href?.startsWith('http') || href?.startsWith('/downloads') || props.download) {
    return (
      <a className={classes} href={href} {...props}>
        {children}
      </a>
    );
  }

  if (href?.startsWith('#')) {
    return (
      <a className={classes} href={href} {...props}>
        {children}
      </a>
    );
  }

  return (
    <Link className={classes} to={href} {...props}>
      {children}
    </Link>
  );
}
