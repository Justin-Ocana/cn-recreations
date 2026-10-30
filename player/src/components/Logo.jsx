// Recreación del logo de Cartoon Network (era tablero de ajedrez) en SVG.
// Para usar el logo oficial, pon tu archivo en /public y reemplaza este componente por un <img>.
export default function Logo() {
  const cells = [];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      if ((r + c) % 2 === 0) cells.push(<rect key={`${r}-${c}`} x={c * 20} y={r * 20} width="20" height="20" />);
    }
  }

  return (
    <svg className="logo" viewBox="0 0 330 100" role="img" aria-label="Cartoon Network">
      <rect width="330" height="100" rx="10" fill="#000" />
      <g transform="translate(0 0)">
        <rect width="100" height="100" rx="10" fill="#fff" />
        <g fill="#000">{cells}</g>
        <text
          x="50"
          y="66"
          textAnchor="middle"
          fontFamily="'Archivo Black', Impact, sans-serif"
          fontSize="52"
          letterSpacing="-2"
          fill="#fff"
          stroke="#000"
          strokeWidth="9"
          paintOrder="stroke"
          strokeLinejoin="round"
        >
          CN
        </text>
      </g>
      <g fontFamily="'Archivo Black', Impact, sans-serif" fill="#fff">
        <text x="118" y="46" fontSize="34" letterSpacing="1">CARTOON</text>
        <text x="118" y="84" fontSize="34" letterSpacing="1">NETWORK</text>
      </g>
    </svg>
  );
}
