import Reveal from './Reveal';

export default function PageHero({ eyebrow, title, description }) {
  return (
    <section className="page-hero section-shell pt-7 sm:pt-12">
      <Reveal className="panel overflow-hidden px-5 py-9 sm:px-10 sm:py-14 lg:px-14">
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgba(40,70,56,0.10),transparent_34%),linear-gradient(315deg,rgba(185,137,82,0.12),transparent_38%)]" />
        <div className="surface-grid pointer-events-none absolute inset-y-0 right-0 hidden w-[34%] opacity-[0.18] lg:block" />
        <div className="relative max-w-3xl">
          <span className="eyebrow">{eyebrow}</span>
          <h1 className="mt-5 max-w-3xl font-display text-[2.35rem] leading-[1.03] tracking-normal text-ink sm:text-5xl lg:text-[3.65rem]">
            {title}
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-ink/72 sm:text-lg sm:leading-8">{description}</p>
        </div>
      </Reveal>
    </section>
  );
}
