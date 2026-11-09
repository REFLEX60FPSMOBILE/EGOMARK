import { motion } from 'motion/react'
import { Check } from 'lucide-react'
import { useState } from 'react'

import { Button } from '../components/Button'
import { Container } from '../components/Container'
import { Reveal } from '../components/Reveal'
import { SectionHeading } from '../components/SectionHeading'
import { pricing } from '../content'
import { cx } from '../lib/cx'

export function Pricing() {
  const [yearly, setYearly] = useState(true)
  return (
    <section id="pricing" className="scroll-mt-24 border-t border-line py-24 sm:py-32">
      <Container>
        <SectionHeading eyebrow={pricing.eyebrow} title={pricing.title} description={pricing.description} />

        <Reveal className="mt-10 flex justify-center">
          <div role="radiogroup" className="depth relative grid h-11 grid-cols-2 rounded-control bg-surface p-1 text-[14px]">
            {(['monthly', 'yearly'] as const).map((period) => {
              const selected = (period === 'yearly') === yearly
              return (
                <button
                  key={period}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setYearly(period === 'yearly')}
                  className={cx('relative z-10 flex items-center justify-center gap-2 rounded-[10px] px-5 transition-colors', selected ? 'text-fg' : 'text-muted hover:text-fg')}
                >
                  {selected && (
                    <motion.span
                      layoutId="billing-pill"
                      className="absolute inset-0 -z-10 rounded-[10px] bg-white/[0.08]"
                      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                    />
                  )}
                  {period === 'monthly' ? 'Monthly' : 'Yearly'}
                  {period === 'yearly' && <span className="rounded-[6px] bg-accent-2/15 px-1.5 py-0.5 text-[11px] text-accent-2">{pricing.yearlyNote}</span>}
                </button>
              )
            })}
          </div>
        </Reveal>

        <div className="mt-10 grid gap-4 lg:grid-cols-3">
          {pricing.tiers.map((tier, i) => {
            const price = yearly ? tier.yearly : tier.monthly
            return (
              <Reveal key={tier.name} delay={i * 0.08} className="h-full">
                <article
                  className={cx(
                    'depth relative flex h-full flex-col rounded-card bg-surface p-7',
                    tier.popular ? '[--depth-edge:rgb(255_122_69/0.45)] [--depth-highlight:rgb(255_181_71/0.25)] shadow-[0_40px_80px_-40px_rgb(255_122_69/0.35)]' : 'shadow-glow',
                  )}
                >
                  {tier.popular && (
                    <span className="absolute right-6 top-6 rounded-[8px] bg-accent/15 px-2 py-1 text-[12px] font-medium text-accent">Popular</span>
                  )}
                  <h3 className="text-[16px] font-semibold">{tier.name}</h3>
                  <p className="mt-1 min-h-[44px] text-[14px] leading-snug text-muted">{tier.description}</p>
                  <div className="mt-6 flex items-baseline gap-1">
                    <span className="text-[44px] font-semibold leading-none tracking-[-0.03em] tabular-nums">${price}</span>
                    <span className="text-[14px] text-muted">{price === 0 ? 'forever' : 'per person, per month'}</span>
                  </div>
                  <Button variant={tier.popular ? 'primary' : 'secondary'} className="mt-7 w-full">
                    {tier.cta}
                  </Button>
                  <ul className="mt-7 flex flex-col gap-3 border-t border-line pt-7">
                    {tier.features.map((f) => (
                      <li key={f} className="flex items-start gap-3 text-[14px] text-fg/90">
                        <span className="mt-0.5 grid size-4.5 shrink-0 place-items-center rounded-[6px] bg-white/[0.08]">
                          <Check className="size-3" />
                        </span>
                        {f}
                      </li>
                    ))}
                  </ul>
                </article>
              </Reveal>
            )
          })}
        </div>
      </Container>
    </section>
  )
}
