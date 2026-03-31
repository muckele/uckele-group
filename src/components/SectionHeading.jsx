export default function SectionHeading({ eyebrow, title, description, align = 'left' }) {
  const alignment = align === 'center' ? 'mx-auto text-center' : '';

  return (
    <div className={`max-w-3xl ${alignment}`}>
      {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
      <h2 className="mt-5 font-display text-3xl leading-tight text-ink sm:text-[2.5rem]">{title}</h2>
      {description ? <p className="mt-4 text-base leading-7 text-ink/72 sm:text-lg">{description}</p> : null}
    </div>
  );
}
