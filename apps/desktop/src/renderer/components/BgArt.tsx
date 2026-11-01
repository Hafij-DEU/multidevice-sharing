// The page backdrop: soft colour blobs, layered waves along the bottom and a faint mesh of linked
// nodes, all drawn in the palette colours (styles.css .bg-art). Decoration only.
const NODES: [number, number][] = [
  [80, 70], [210, 40], [330, 120], [180, 170], [420, 60], [470, 190], [300, 250], [120, 260],
];
const LINKS: [number, number][] = [
  [0, 1], [1, 2], [0, 3], [3, 2], [2, 4], [4, 5], [2, 5], [3, 6], [6, 5], [3, 7], [7, 6],
];

export function BgArt() {
  return (
    <div className="bg-art" aria-hidden="true">
      <span className="blob b1" />
      <span className="blob b2" />
      <span className="blob b3" />
      <svg className="bg-mesh" viewBox="0 0 520 300">
        {LINKS.map(([a, b]) => {
          const [x1, y1] = NODES[a] ?? [0, 0];
          const [x2, y2] = NODES[b] ?? [0, 0];
          return <line key={`${a}-${b}`} x1={x1} y1={y1} x2={x2} y2={y2} />;
        })}
        {NODES.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={i % 3 === 0 ? 6 : 4} />
        ))}
      </svg>
      <svg className="bg-waves" viewBox="0 0 1440 320" preserveAspectRatio="none">
        <defs>
          <linearGradient id="bgw" x1="0" x2="1">
            <stop offset="0" className="s1" />
            <stop offset="0.5" className="s2" />
            <stop offset="1" className="s3" />
          </linearGradient>
        </defs>
        <path className="w1" d="M0 190C180 140 360 120 560 160S940 250 1140 210 1360 130 1440 150V320H0Z" />
        <path className="w2" d="M0 240C220 200 420 260 640 240S1040 170 1240 210 1400 260 1440 250V320H0Z" />
        <path className="w3" d="M0 220C260 260 520 200 760 230S1180 290 1440 240" />
        <path className="w3" d="M0 260C300 230 560 290 820 260S1200 220 1440 270" />
      </svg>
    </div>
  );
}
