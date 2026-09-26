import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Svg(props: IconProps) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

export const PenIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20l3.5-.8L19 7.7a2.1 2.1 0 0 0-3-3L4.5 16.2 4 20z" />
    <path d="M14.5 6.2l3 3" />
  </Svg>
);

export const EraserIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.5 20H20" />
    <path d="M5.3 15.6l8.9-8.9a2 2 0 0 1 2.8 0l2.3 2.3a2 2 0 0 1 0 2.8L12.6 18.5a5 5 0 0 1-3.5 1.5H8.4a2 2 0 0 1-1.4-.6l-1.7-1.7a1.5 1.5 0 0 1 0-2.1z" />
    <path d="M9.6 11.3l4.6 4.6" />
  </Svg>
);

/** A label chip reading "SC" (the Wyckoff label tool). */
export const LabelIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="5.5" width="19" height="13" rx="3" />
    <text x="12" y="15.5" textAnchor="middle" fontSize="9.5" fontWeight="800" fill="currentColor" stroke="none">
      SC
    </text>
  </Svg>
);

/** A dashed selection box with a pointer arrow (the select tool). */
export const SelectIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="12" height="12" rx="1.5" strokeDasharray="2.4 2.4" />
    <path d="M11 11l9.5 3.6-4.1 1.4-1.4 4.1z" fill="currentColor" />
  </Svg>
);

export const UndoIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
);

export const RedoIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </Svg>
);

export const MouseIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6.5" y="3" width="11" height="18" rx="5.5" />
    <path d="M12 7v3" />
  </Svg>
);

export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16" />
    <path d="M10 11v6M14 11v6" />
    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
    <path d="M9 7V4h6v3" />
  </Svg>
);

export const CameraIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.6-2h5.8l1.6 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />
    <circle cx="12" cy="13" r="3.3" />
  </Svg>
);

export const AutoFitIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />
    <path d="M9.5 15l2.5-6 2.5 6M10.3 13h3.4" />
  </Svg>
);

export const CloudIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 18.5a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1-.5 7.97V16.5" />
    <path d="M7 18.5h10" />
  </Svg>
);

export const WritingIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 17c2-3 3.5-7 5-7s-1 7 1 7 3-5 4.5-5-.5 5 1.5 5 3-2 5.5-3" />
  </Svg>
);

export const CopyIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </Svg>
);

export const DownloadIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v11M7 10.5l5 5 5-5" />
    <path d="M5 20h14" />
  </Svg>
);

export const ShareIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 15V4M8 7.5l4-3.5 4 3.5" />
    <path d="M7 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1" />
  </Svg>
);
