const PlayIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.4-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" fill="currentColor" />
  </svg>
);

const GearIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <g fill="currentColor">
      {[0, 45, 90, 135].map((a) => (
        <rect key={a} x="10" y="1.5" width="4" height="21" rx="1.2" transform={`rotate(${a} 12 12)`} />
      ))}
      <circle cx="12" cy="12" r="7.4" />
    </g>
    <circle cx="12" cy="12" r="3.2" fill="#15171b" />
  </svg>
);

const NUMBERS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

export default function Remote({ onPlay, onConfig, transmitting }) {
  return (
    <div className="remote">
      <div className={`remote__ir${transmitting ? " is-tx" : ""}`} aria-hidden="true">
        <i />
      </div>

      <div className="remote__brand" aria-hidden="true">
        <b>CN</b>
        <span>TV&nbsp;REMOTE</span>
      </div>

      <div className="remote__main">
        <div className="keywrap">
          <button className="key key--play" onClick={onPlay} aria-label="Reproducir">
            <PlayIcon />
          </button>
          <span className="keylabel">Reproducir</span>
        </div>
        <div className="keywrap">
          <button className="key key--cfg" onClick={onConfig} aria-label="Configuración">
            <GearIcon />
          </button>
          <span className="keylabel">Config</span>
        </div>
      </div>

      <div className="remote__dpad" aria-hidden="true">
        <span className="dpad__arrow dpad__arrow--u" />
        <span className="dpad__arrow dpad__arrow--r" />
        <span className="dpad__arrow dpad__arrow--d" />
        <span className="dpad__arrow dpad__arrow--l" />
        <span className="dpad__ok">OK</span>
      </div>

      <div className="remote__rockers" aria-hidden="true">
        <div className="rocker"><span>+</span><em>VOL</em><span>−</span></div>
        <div className="rocker"><span>+</span><em>CH</em><span>−</span></div>
      </div>

      <div className="remote__numpad" aria-hidden="true">
        {NUMBERS.map((n) => (
          <span key={n}>{n}</span>
        ))}
      </div>
    </div>
  );
}
