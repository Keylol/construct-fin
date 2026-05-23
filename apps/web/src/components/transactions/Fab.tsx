'use client';

interface FabProps {
  onClick: () => void;
  label?: string;
}

export function Fab({ onClick, label = '+' }: FabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Добавить операцию"
      className="fixed z-30 bottom-20 md:bottom-8 right-5 md:right-8 h-14 w-14 rounded-full bg-tint text-white text-3xl font-light shadow-lg shadow-tint/30 hover:scale-105 active:scale-95 transition flex items-center justify-center"
    >
      {label}
    </button>
  );
}
