import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

export default function FaqAccordion({ items, defaultOpen = 0 }) {
  const [openIndex, setOpenIndex] = useState(defaultOpen);

  return (
    <div className="space-y-4">
      {items.map((item, index) => {
        const isOpen = openIndex === index;

        return (
          <div key={item.question} className="panel overflow-hidden">
            <h3>
              <button
                aria-controls={`faq-panel-${index}`}
                aria-expanded={isOpen}
                className="flex w-full items-center justify-between gap-6 px-6 py-5 text-left sm:px-7"
                onClick={() => setOpenIndex(isOpen ? -1 : index)}
                type="button"
              >
                <span className="text-base font-semibold text-ink">{item.question}</span>
                <ChevronDown
                  aria-hidden="true"
                  className={`h-5 w-5 shrink-0 text-moss transition ${isOpen ? 'rotate-180' : ''}`}
                />
              </button>
            </h3>

            <div
              className={`grid transition-[grid-template-rows] duration-300 ${isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
              id={`faq-panel-${index}`}
            >
              <div className="overflow-hidden">
                <p className="px-6 pb-6 text-sm leading-7 text-ink/75 sm:px-7">{item.answer}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
