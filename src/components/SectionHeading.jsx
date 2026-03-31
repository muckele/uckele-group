export default function SectionHeading({ eyebrow, title, description, align = 'left' }) {
  const alignment = align === 'center' ? 'mx-auto text-center' : '';
  const descriptionAlignment = align === 'center' ? 'mx-auto' : '';

  return (
    <div className={`max-w-3xl ${alignment}`}>
      {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
      <h2 className="mt-5 font-display text-[2.15rem] leading-[1.05] tracking-[-0.03em] text-ink sm:text-[2.8rem]">{title}</h2>
      {description ? <p className={`mt-4 max-w-2xl text-base leading-7 text-ink/72 sm:text-lg ${descriptionAlignment}`}>{description}</p> : null}
    </div>
  );
}
