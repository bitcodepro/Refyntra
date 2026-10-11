export interface ButtonProps {
  label: string;
  size: number;
  onClick?: () => void;
  variant?: 'primary' | 'secondary';
}

export function Button({ label, size, onClick }: ButtonProps) {
  return (
    <button onClick={onClick} data-size={size}>
      {label}
    </button>
  );
}
