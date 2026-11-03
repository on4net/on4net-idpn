import { cn } from '@/lib/utils';

export interface SpinnerProps {
  className?: string;
  /** Visible to screen readers only; pass the localized loading message. */
  label: string;
}

export function Spinner({ className, label }: SpinnerProps) {
  return (
    <span role="status" className={cn('inline-flex items-center', className)}>
      <svg
        className="size-4 animate-spin text-muted-foreground"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
        <path
          d="M22 12a10 10 0 0 1-10 10"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
        />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
