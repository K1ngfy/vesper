import { VESPER_LOGO_PATHS, VESPER_LOGO_VIEWBOX } from '../brand';

interface VesperLogoProps {
  size?: number;
  className?: string;
}

/** VESPER 品牌徽标组件：半阖之瞳（Veiled Eye） */
export default function VesperLogo({ size = 20, className = '' }: VesperLogoProps) {
  return (
    <svg
      viewBox={VESPER_LOGO_VIEWBOX}
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={`inline-block shrink-0 ${className}`.trim()}
      style={{ color: 'var(--vesper-accent)' }}
    >
      {VESPER_LOGO_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
