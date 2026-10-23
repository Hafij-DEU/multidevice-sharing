/** A string that came from another device: always plain text, isolated from surrounding bidi. */
export function Peer({ text, className }: { text: string; className?: string }) {
  return (
    <span dir="auto" className={className ? `peer ${className}` : 'peer'}>
      {text}
    </span>
  );
}
