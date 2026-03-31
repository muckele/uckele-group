import Reveal from './Reveal';

export default function PageHero({ eyebrow, title, description }) {
  return (
    <section className="section-shell pt-10 sm:pt-14">
      <Reveal className="panel overflow-hidden px-7 py-12 sm:px-10 sm:py-16 lg:px-14">
        <div className="max-w-3xl">
          <span className="eyebrow">{eyebrow}</span>
          <h1 className="mt-6 max-w-3xl font-display text-4xl leading-tight text-ink sm:text-5xl lg:text-[3.6rem]">
            {title}
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-ink/72">{description}</p>
        </div>
      </Reveal>
    </section>
  );
}
