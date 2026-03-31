import Reveal from './Reveal';

export default function PageHero({ eyebrow, title, description }) {
  return (
    <section className="section-shell pt-10 sm:pt-14">
      <Reveal className="panel overflow-hidden px-7 py-12 sm:px-10 sm:py-16 lg:px-14">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(40,70,56,0.12),transparent_30%),radial-gradient(circle_at_bottom_left,rgba(185,137,82,0.14),transparent_34%)]" />
        <div className="surface-grid pointer-events-none absolute inset-y-0 right-0 hidden w-[34%] opacity-[0.18] lg:block" />
        <div className="relative max-w-3xl">
          <span className="eyebrow">{eyebrow}</span>
          <h1 className="mt-6 max-w-3xl font-display text-4xl leading-[0.98] tracking-[-0.035em] text-ink sm:text-5xl lg:text-[3.8rem]">
            {title}
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-ink/72">{description}</p>
        </div>
      </Reveal>
    </section>
  );
}
