import { useRef, useState, type PointerEvent } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

type OverviewSection = {
  title: string;
  text: string;
  bullets?: string[];
};

type SiteOverviewPanelProps = {
  id: string;
  eyebrow: string;
  title: string;
  summary: string;
  sections: OverviewSection[];
};

export function SiteOverviewPanel({
  id,
  eyebrow,
  title,
  summary,
  sections,
}: SiteOverviewPanelProps) {
  const [open, setOpen] = useState(false);
  const dragStartY = useRef<number | null>(null);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    dragStartY.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const startY = dragStartY.current;
    dragStartY.current = null;
    if (startY === null) return;

    const deltaY = event.clientY - startY;
    if (Math.abs(deltaY) >= 32) setOpen(deltaY > 0);
  };

  return (
    <section className="border-b border-[#2c323a] bg-[#101318]">
      <div className="mx-auto max-w-[1440px] px-5 py-4 sm:px-8 lg:px-12">
        <div className="overflow-hidden border border-[#3a342d] bg-[#12161b] shadow-[0_14px_40px_rgba(0,0,0,0.16)]">
          <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-5">
            <div className="min-w-0">
              <p className="font-mono text-[9px] uppercase tracking-[0.22em] text-[#d99a54]">
                {eyebrow}
              </p>
              <h2 className="mt-1 font-display text-xl font-semibold tracking-[-0.03em] text-[#f3efe5] sm:text-2xl">
                {title}
              </h2>
              <p className="mt-2 max-w-4xl font-sans text-sm leading-6 text-[#aeb7c1]">
                {summary}
              </p>
            </div>
            <button
              type="button"
              aria-expanded={open}
              aria-controls={id}
              onClick={() => setOpen(value => !value)}
              className="inline-flex shrink-0 items-center justify-center gap-2 border border-[#d99a54]/70 px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[#f3efe5] transition-colors hover:bg-[#d99a54]/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d99a54]"
            >
              {open ? "Hide overview" : "Explore this site"}
              {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
          </div>

          <div
            className="flex h-7 touch-none cursor-grab items-center justify-center active:cursor-grabbing"
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => { dragStartY.current = null; }}
            role="presentation"
            aria-hidden="true"
            title="Drag down to open or up to close"
          >
            <span className="h-1 w-12 rounded-full bg-[#718092]/70 transition-colors hover:bg-[#d99a54]" />
          </div>

          <div
            id={id}
            aria-hidden={!open}
            className={`grid overflow-hidden transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
          >
            <div className="min-h-0">
              <div className={`border-t border-[#2c323a] px-4 py-4 transition-opacity duration-200 motion-reduce:transition-none sm:px-6 sm:py-6 ${open ? "opacity-100" : "opacity-0"}`}>
                <div className="grid gap-3 sm:grid-cols-2">
                  {sections.map(section => (
                    <section
                      key={section.title}
                      className="border-l border-[#d99a54]/60 bg-[#0b0d10]/55 p-4 sm:p-5"
                    >
                      <h3 className="font-display text-base font-semibold text-[#f3efe5]">
                        {section.title}
                      </h3>
                      <p className="mt-2 font-sans text-sm leading-6 text-[#aeb7c1]">
                        {section.text}
                      </p>
                      {section.bullets && section.bullets.length > 0 && (
                        <ul className="mt-3 space-y-2 font-sans text-sm leading-5 text-[#d9d3c6]">
                          {section.bullets.map(item => (
                            <li key={item} className="flex gap-2">
                              <span className="mt-[0.55em] h-1.5 w-1.5 shrink-0 bg-[#d99a54]" aria-hidden="true" />
                              <span>{item}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  ))}
                </div>
                <p className="mt-4 text-center font-mono text-[9px] uppercase tracking-[0.13em] text-[#718092]">
                  Use the button or drag the handle to open / close
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
