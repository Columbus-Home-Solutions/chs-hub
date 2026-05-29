interface SpinnerProps {
  center?: boolean;
}

export function Spinner({ center }: SpinnerProps) {
  return <span class={`spinner${center ? " spinner--center" : ""}`} role="status" aria-label="Loading" />;
}
