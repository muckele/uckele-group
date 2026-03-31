import { Link } from 'react-router-dom';

function getVariantClasses(variant) {
  if (variant === 'secondary') {
    return 'border border-ink/10 bg-white/70 text-ink hover:border-moss/30 hover:bg-white';
  }

  if (variant === 'ghost') {
    return 'border border-transparent bg-transparent text-ink hover:border-ink/10 hover:bg-white/50';
  }

  return 'border border-moss bg-moss text-white hover:border-pine hover:bg-pine';
}

export default function ButtonLink({ href, children, variant = 'primary', className = '', ...props }) {
  const classes = `inline-flex items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-semibold transition duration-300 ${getVariantClasses(
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
