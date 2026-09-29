// Inline 16px stroke icons. One consistent weight so they read as instrument glyphs.
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = (size: number, rest: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> => ({
  width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, ...rest,
});

export const IconPlay = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M5 3.5v9l7-4.5z" fill="currentColor" stroke="none" /></svg>
);
export const IconPause = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M5 3.5v9M11 3.5v9" strokeWidth={2} /></svg>
);
export const IconEye = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></svg>
);
export const IconFollow = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v2.5M8 12v2.5M1.5 8H4M12 8h2.5" /></svg>
);
export const IconInfo = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><circle cx="8" cy="8" r="6.5" /><path d="M8 7v4M8 5v.2" /></svg>
);
export const IconChevron = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M6 3.5 10.5 8 6 12.5" /></svg>
);
export const IconClose = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M4 4l8 8M12 4l-8 8" /></svg>
);
export const IconPeople = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><circle cx="6" cy="5.5" r="2.5" /><path d="M1.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" /><circle cx="11.5" cy="6" r="2" /><path d="M11.5 9.5c1.8 0 3 1.2 3 3.2" /></svg>
);
export const IconFight = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M2.5 13.5 12 4M12 4l1.5-1.5M10.5 2.5 13.5 5.5M13.5 13.5 4 4M4 4 2.5 2.5M5.5 2.5 2.5 5.5" /></svg>
);
export const IconLove = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M8 13.5S2 9.8 2 5.8A3 3 0 0 1 8 4.5a3 3 0 0 1 6 1.3c0 4-6 7.7-6 7.7z" /></svg>
);
export const IconFeed = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M4 2v5.5M2.5 2v3a1.5 1.5 0 0 0 3 0V2M4 7.5V14M11 2c-1.5 1-2 3-2 5.5 0 1 .5 1.5 1.5 1.5H12V14M12 2v7" /></svg>
);
export const IconScare = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M8 2 9.6 6h4.2l-3.4 2.5 1.3 4.2L8 10.2l-3.7 2.5 1.3-4.2L2.2 6h4.2z" /></svg>
);
export const IconDust = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><circle cx="4" cy="5" r="1" fill="currentColor" stroke="none" /><circle cx="9" cy="3.5" r="1" fill="currentColor" stroke="none" /><circle cx="12.5" cy="7" r="1" fill="currentColor" stroke="none" /><circle cx="6.5" cy="9.5" r="1" fill="currentColor" stroke="none" /><circle cx="11" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="3.5" cy="12.5" r="1" fill="currentColor" stroke="none" /></svg>
);
export const IconSleep = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M13 10.5A6 6 0 0 1 5.5 3a6 6 0 1 0 7.5 7.5z" /></svg>
);
export const IconReward = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M8 2.5v11M3.5 8H12.5" /><circle cx="8" cy="8" r="6" /></svg>
);
export const IconPunish = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M3.5 8H12.5" /><circle cx="8" cy="8" r="6" /></svg>
);
export const IconSpawn = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><circle cx="8" cy="5" r="2.5" /><path d="M3 14c0-3 2.2-4.5 5-4.5s5 1.5 5 4.5" /><path d="M13 2v3M11.5 3.5h3" /></svg>
);
export const IconRemove = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5 5 13h6l.5-8.5" /></svg>
);
export const IconBolt = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M9 1.5 3.5 9h4l-.5 5.5L12.5 7h-4z" /></svg>
);
export const IconMute = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M2.5 6v4h2.5L9 13V3L5 6z" /><path d="M11 6l3 4M14 6l-3 4" /></svg>
);
export const IconGrid = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><rect x="2.5" y="2.5" width="4" height="4" rx="1" /><rect x="9.5" y="2.5" width="4" height="4" rx="1" /><rect x="2.5" y="9.5" width="4" height="4" rx="1" /><rect x="9.5" y="9.5" width="4" height="4" rx="1" /></svg>
);
export const IconKeyboard = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><path d="M4 7h.1M6.5 7h.1M9 7h.1M11.5 7h.1M5 9.5h6" /></svg>
);
export const IconRiot = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M8 1.5 9.5 5.5l3-2-1 3.5 3 1-3 1.5 1.5 3.5-3.5-1.5L8 14.5l-1.5-3-3.5 1.5L4.5 9.5l-3-1.5 3-1-1-3.5 3 2z" /></svg>
);
export const IconFestival = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M3 14.5 6 5l5 5z" /><path d="M8.5 2.5v.1M12.5 4.5v.1M13.5 9v.1M10.5 1.5v.1" strokeWidth={2} /><path d="M9.5 3.5c1-1 2-1 3 0M11 7c1 0 2 .5 2.5 1.5" /></svg>
);
export const IconLoveWave = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M8 10.5S4 8 4 5.6A2 2 0 0 1 8 4.8a2 2 0 0 1 4 .8c0 2.4-4 4.9-4 4.9z" /><path d="M1.5 13c1.5 1.2 3 1.2 4.5 0s3-1.2 4.5 0 3 1.2 4 0" /></svg>
);
export const IconPanic = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M8 2 14.5 13.5h-13z" /><path d="M8 6.5v3.5M8 12v.2" /></svg>
);
export const IconCalm = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M2 6c2-1.3 4-1.3 6 0s4 1.3 6 0M2 10c2-1.3 4-1.3 6 0s4 1.3 6 0" /></svg>
);
