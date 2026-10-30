/** Marca do produto: símbolo em SVG próprio (sem fonte nem imagem de terceiros). */
export function BrandMark({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={className}>
      <rect width="32" height="32" rx="9" className="fill-rose-700" />
      <circle cx="11" cy="21.5" r="3.4" className="fill-none stroke-white" strokeWidth="2.2" />
      <circle cx="21" cy="21.5" r="3.4" className="fill-none stroke-white" strokeWidth="2.2" />
      <path
        d="M13.5 19 22 7.5M18.5 19 10 7.5"
        className="stroke-white"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
