/* @ds-bundle: {"format":3,"namespace":"AkkuDesignSystem_d21dea","components":[{"name":"AkkuLogo","sourcePath":"akku-logo/react/AkkuLogo.jsx"}],"sourceHashes":{"akku-logo/react/AkkuLogo.jsx":"ade7ad957fc6","akku-score/app.jsx":"1cd794e5d538","akku-score/charge-marks.js":"c70f03d735d0","design-canvas.jsx":"5d0e39003628"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.AkkuDesignSystem_d21dea = window.AkkuDesignSystem_d21dea || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// akku-logo/react/AkkuLogo.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
// AkkuLogo — React component
// Usage:
//   <AkkuLogo />                       // 80x80, forest #1B4332
//   <AkkuLogo size={48} color="#FFF"/> // custom size + colour
//   <AkkuLogo lockup />                // mark + "Akku" wordmark
//
// Wordmark requires Outfit 700 to be loaded, e.g.:
//   <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@700&display=swap" rel="stylesheet"/>

function AkkuLogo({
  size = 80,
  color = '#1B4332',
  lockup = false,
  textColor,
  className,
  style,
  ...rest
}) {
  if (lockup) {
    const w = size * (280 / 80);
    return /*#__PURE__*/React.createElement("svg", _extends({
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: "0 0 280 80",
      width: w,
      height: size,
      role: "img",
      "aria-label": "Akku",
      className: className,
      style: style
    }, rest), /*#__PURE__*/React.createElement("polygon", {
      points: "22,10 58,10 32,46",
      fill: color
    }), /*#__PURE__*/React.createElement("polygon", {
      points: "48,34 58,70 22,70",
      fill: color
    }), /*#__PURE__*/React.createElement("text", {
      x: "100",
      y: "58",
      fontFamily: "Outfit, system-ui, sans-serif",
      fontWeight: "700",
      fontSize: "56",
      letterSpacing: "-1.7",
      fill: textColor || color
    }, "Akku"));
  }
  return /*#__PURE__*/React.createElement("svg", _extends({
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: "0 0 80 80",
    width: size,
    height: size,
    role: "img",
    "aria-label": "Akku logo",
    className: className,
    style: style
  }, rest), /*#__PURE__*/React.createElement("polygon", {
    points: "22,10 58,10 32,46",
    fill: color
  }), /*#__PURE__*/React.createElement("polygon", {
    points: "48,34 58,70 22,70",
    fill: color
  }));
}
Object.assign(__ds_scope, { AkkuLogo });
})(); } catch (e) { __ds_ns.__errors.push({ path: "akku-logo/react/AkkuLogo.jsx", error: String((e && e.message) || e) }); }

// akku-score/app.jsx
try { (() => {
/* Akku Score — exploration canvas app */
const {
  useState,
  useEffect
} = React;
const akkuScoreStyles = {
  forest: '#1B4332',
  forestLight: '#2D6A4F',
  muted: '#52796F',
  faint: '#84a98c',
  mint: '#D8F3DC',
  mintBg: '#EAF4EC',
  cream: '#F8F9F8',
  border: 'rgba(27,67,50,0.14)',
  serif: "'Playfair Display', Georgia, serif",
  sans: "'Outfit', system-ui, sans-serif"
};

// ── Reusable mark wrapper ────────────────────────────────────
function Mark({
  variant,
  score,
  size,
  showNumber = false,
  numberSize,
  numberColor,
  color,
  track,
  bg
}) {
  const html = window.akkuChargeSVG({
    variant,
    score,
    size,
    showNumber,
    numberSize,
    numberColor,
    color,
    track,
    bg
  });
  return React.createElement('span', {
    style: {
      display: 'inline-flex',
      lineHeight: 0
    },
    dangerouslySetInnerHTML: {
      __html: html
    }
  });
}
const FOREST = '#1B4332';
const SAGE = '#52B788';
const MINT = '#D8F3DC';

// ── Logo / brand-mark treatment for one variant ──────────────
function LogoCard({
  variant,
  title
}) {
  const fill = window.AKKU_BRAND_FILL[variant];
  // resting mono mark (forest, no track, no number)
  const mono = (size, color, track = 'none', bg) => /*#__PURE__*/React.createElement(Mark, {
    variant: variant,
    score: fill,
    size: size,
    color: color,
    track: track,
    bg: bg
  });
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: '#fff',
      fontFamily: akkuScoreStyles.sans
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: '#fff',
      padding: '30px 0 26px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 4,
      borderBottom: `1px solid ${akkuScoreStyles.border}`
    }
  }, mono(104, FOREST), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: akkuScoreStyles.serif,
      fontWeight: 700,
      fontSize: 19,
      color: FOREST,
      marginTop: 12
    }
  }, title), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: akkuScoreStyles.faint,
      fontWeight: 500,
      letterSpacing: '0.04em'
    }
  }, "resting state \xB7 no number")), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '18px 20px 22px',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: akkuScoreStyles.eyebrow
  }, "Lockup"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '14px 18px',
      background: akkuScoreStyles.cream,
      borderRadius: 14,
      border: `1px solid ${akkuScoreStyles.border}`
    }
  }, mono(42, FOREST), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: akkuScoreStyles.sans,
      fontWeight: 700,
      fontSize: 32,
      letterSpacing: '-0.03em',
      color: FOREST
    }
  }, "Akku"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: akkuScoreStyles.eyebrow
  }, "App icon \xB7 reversed"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 7
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 76,
      height: 76,
      borderRadius: 18,
      background: MINT,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: '0 2px 8px rgba(27,67,50,0.10)'
    }
  }, mono(48, FOREST)), /*#__PURE__*/React.createElement("span", {
    style: akkuScoreStyles.tinyLabel
  }, "light")), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 7
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 76,
      height: 76,
      borderRadius: 18,
      background: FOREST,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: '0 2px 8px rgba(27,67,50,0.10)'
    }
  }, mono(48, MINT)), /*#__PURE__*/React.createElement("span", {
    style: akkuScoreStyles.tinyLabel
  }, "dark")), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 7
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 76,
      height: 76,
      borderRadius: 18,
      background: SAGE,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: '0 2px 8px rgba(27,67,50,0.10)'
    }
  }, mono(48, '#FFFFFF')), /*#__PURE__*/React.createElement("span", {
    style: akkuScoreStyles.tinyLabel
  }, "sage")))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: akkuScoreStyles.eyebrow
  }, "Favicon scale"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 22,
      padding: '12px 18px',
      background: akkuScoreStyles.cream,
      borderRadius: 14,
      border: `1px solid ${akkuScoreStyles.border}`
    }
  }, [32, 24, 16].map(s => /*#__PURE__*/React.createElement("div", {
    key: s,
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 7
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 32,
      display: 'flex',
      alignItems: 'center'
    }
  }, mono(s, FOREST)), /*#__PURE__*/React.createElement("span", {
    style: akkuScoreStyles.tinyLabel
  }, s, "px"))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 7
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 32,
      height: 32,
      borderRadius: 7,
      background: FOREST,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, mono(22, MINT)), /*#__PURE__*/React.createElement("span", {
    style: akkuScoreStyles.tinyLabel
  }, "tab"))))));
}

// Simple storefront glyph (echoes the screenshot avatar)
function StoreGlyph({
  size = 22,
  color = '#2D6A4F'
}) {
  return /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: "1.6",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M3 9l1.5-4.5h15L21 9"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M4 9v10h16V9"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M3 9a2.4 2.4 0 0 0 4.5 0 2.4 2.4 0 0 0 4.5 0 2.4 2.4 0 0 0 4.5 0 2.4 2.4 0 0 0 4.5 0"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M9 19v-5h6v5"
  }));
}
function Chevron({
  color
}) {
  return /*#__PURE__*/React.createElement("svg", {
    width: "12",
    height: "12",
    viewBox: "0 0 12 12",
    fill: "none",
    stroke: color,
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M3 4.5L6 7.5L9 4.5"
  }));
}

// ── The score pill, faithful to the app screenshot ───────────
function ScorePill({
  variant,
  score
}) {
  const deep = window.akkuRampDeep(score);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 7,
      background: '#fff',
      border: '1px solid rgba(27,67,50,0.12)',
      borderRadius: 100,
      padding: '4px 9px 4px 5px',
      boxShadow: '0 1px 2px rgba(27,67,50,0.06)'
    }
  }, /*#__PURE__*/React.createElement(Mark, {
    variant: variant,
    score: score,
    size: 22
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: akkuScoreStyles.sans,
      fontWeight: 700,
      fontSize: 15,
      color: akkuScoreStyles.forest,
      fontVariantNumeric: 'tabular-nums',
      lineHeight: 1
    }
  }, Math.round(score)), /*#__PURE__*/React.createElement(Chevron, {
    color: akkuScoreStyles.muted
  }));
}

// ── Compact café-card recreation ("reused inside the app") ───
function AppContext({
  variant,
  score
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: '#fff',
      borderRadius: 18,
      border: `1px solid ${akkuScoreStyles.border}`,
      padding: 16,
      boxShadow: '0 6px 18px rgba(27,67,50,0.06)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      marginBottom: 13
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 44,
      height: 44,
      borderRadius: 13,
      flexShrink: 0,
      background: akkuScoreStyles.mint,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(StoreGlyph, null)), /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: akkuScoreStyles.serif,
      fontWeight: 700,
      fontSize: 17,
      color: akkuScoreStyles.forest,
      lineHeight: 1.15,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, "QA Minimal Owner Cafe"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: akkuScoreStyles.sans,
      fontWeight: 300,
      fontSize: 12.5,
      color: akkuScoreStyles.muted
    }
  }, "Essen & Trinken \xB7 Heidelberg"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: akkuScoreStyles.sans,
      fontWeight: 500,
      fontSize: 12.5,
      color: akkuScoreStyles.muted,
      background: akkuScoreStyles.cream,
      border: `1px solid ${akkuScoreStyles.border}`,
      borderRadius: 100,
      padding: '5px 11px',
      whiteSpace: 'nowrap',
      flexShrink: 0
    }
  }, "Closed now"), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(ScorePill, {
    variant: variant,
    score: score
  })));
}

// ── One direction = one artboard ─────────────────────────────
function Direction({
  variant,
  score,
  title,
  desc
}) {
  const sizes = [{
    px: 52,
    num: true
  }, {
    px: 30,
    num: true
  }, {
    px: 22,
    num: false
  }, {
    px: 16,
    num: false
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: '#fff',
      fontFamily: akkuScoreStyles.sans
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: `linear-gradient(160deg, ${akkuScoreStyles.cream}, ${akkuScoreStyles.mintBg})`,
      padding: '34px 0 30px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      borderBottom: `1px solid ${akkuScoreStyles.border}`
    }
  }, /*#__PURE__*/React.createElement(Mark, {
    variant: variant,
    score: score,
    size: 156,
    showNumber: true,
    numberSize: 29
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '20px 22px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: 18,
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: akkuScoreStyles.serif,
      fontWeight: 700,
      fontSize: 22,
      color: akkuScoreStyles.forest,
      marginBottom: 5
    }
  }, title), /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 300,
      fontSize: 13.5,
      lineHeight: 1.5,
      color: akkuScoreStyles.muted,
      textWrap: 'pretty'
    }
  }, desc)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: akkuScoreStyles.eyebrow
  }, "In the app"), /*#__PURE__*/React.createElement(AppContext, {
    variant: variant,
    score: score
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: akkuScoreStyles.eyebrow
  }, "Legibility \xB7 live score"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-end',
      gap: 22,
      padding: '14px 16px',
      background: akkuScoreStyles.cream,
      borderRadius: 14,
      border: `1px solid ${akkuScoreStyles.border}`
    }
  }, sizes.map(s => /*#__PURE__*/React.createElement("div", {
    key: s.px,
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 56,
      display: 'flex',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement(Mark, {
    variant: variant,
    score: score,
    size: s.px,
    showNumber: s.num,
    numberSize: 32
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10.5,
      color: akkuScoreStyles.faint,
      fontWeight: 500,
      fontVariantNumeric: 'tabular-nums'
    }
  }, s.px, "px")))))));
}
akkuScoreStyles.eyebrow = {
  fontFamily: akkuScoreStyles.sans,
  fontWeight: 700,
  fontSize: 10.5,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: akkuScoreStyles.faint,
  marginBottom: 10
};
akkuScoreStyles.tinyLabel = {
  fontSize: 10.5,
  color: akkuScoreStyles.faint,
  fontWeight: 500,
  fontVariantNumeric: 'tabular-nums'
};
const DIRECTIONS = [{
  variant: 'arc',
  title: 'Arc Sweep',
  desc: 'A single clean stroke closes the loop as the score climbs. Calm and modern — reads perfectly at any size.'
}, {
  variant: 'liquid',
  title: 'Liquid Cell',
  desc: 'The cell fills like a charging battery — literal and friendly, with a soft surface wave. Most playful.'
}, {
  variant: 'gauge',
  title: 'Open Gauge',
  desc: 'An open meter settling on a reading. Familiar “score” language with a clear empty-to-full sweep.'
}, {
  variant: 'segmented',
  title: 'Segmented',
  desc: 'Discrete ticks light up one by one — tangible, countable progress you can almost feel charging.'
}, {
  variant: 'comet',
  title: 'Comet Charge',
  desc: 'A glowing head races around the ring — a sense of live, incoming energy. Great for the charge-up moment.'
}, {
  variant: 'pennant',
  title: 'Pennant Ring',
  desc: 'Folded triangles borrow the bolt’s DNA, filling around the ring. The closest sibling to the Akku logo.'
}];

// ── Top control bar (fixed, outside the zoom) ────────────────
function ControlBar({
  score,
  setScore
}) {
  const deep = window.akkuRampDeep(score);
  const state = window.akkuScoreState(score);
  const presets = [9, 16, 48, 73, 96];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 50,
      background: 'rgba(248,249,248,0.86)',
      backdropFilter: 'blur(12px)',
      borderBottom: `1px solid ${akkuScoreStyles.border}`,
      display: 'flex',
      alignItems: 'center',
      gap: 26,
      padding: '12px 24px',
      fontFamily: akkuScoreStyles.sans
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      minWidth: 188
    }
  }, /*#__PURE__*/React.createElement(Mark, {
    variant: "arc",
    score: score,
    size: 40,
    showNumber: true,
    numberSize: 30
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: akkuScoreStyles.serif,
      fontWeight: 700,
      fontSize: 18,
      color: akkuScoreStyles.forest,
      lineHeight: 1
    }
  }, "Akku Score"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 500,
      color: deep,
      marginTop: 3
    }
  }, state))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      flex: 1,
      maxWidth: 460
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: "0",
    max: "100",
    value: score,
    onChange: e => setScore(Number(e.target.value)),
    style: {
      flex: 1,
      height: 6,
      borderRadius: 3,
      appearance: 'none',
      WebkitAppearance: 'none',
      outline: 'none',
      background: 'linear-gradient(90deg, oklch(63% 0.155 28), oklch(63% 0.155 85), oklch(63% 0.155 142))'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700,
      fontSize: 16,
      color: akkuScoreStyles.forest,
      width: 30,
      textAlign: 'right',
      fontVariantNumeric: 'tabular-nums'
    }
  }, score)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 7
    }
  }, presets.map(p => /*#__PURE__*/React.createElement("button", {
    key: p,
    onClick: () => setScore(p),
    style: {
      border: `1px solid ${score === p ? akkuScoreStyles.forest : akkuScoreStyles.border}`,
      background: score === p ? akkuScoreStyles.forest : '#fff',
      color: score === p ? '#fff' : akkuScoreStyles.muted,
      borderRadius: 100,
      padding: '5px 11px',
      fontSize: 12.5,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: akkuScoreStyles.sans,
      fontVariantNumeric: 'tabular-nums'
    }
  }, p))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: akkuScoreStyles.faint,
      fontWeight: 400
    }
  }, "drag to charge \u2192"));
}
function App() {
  const [score, setScore] = useState(16);

  // thumb styling for the range input
  useEffect(() => {
    if (document.getElementById('akku-range-css')) return;
    const s = document.createElement('style');
    s.id = 'akku-range-css';
    s.textContent = `
      input[type=range]::-webkit-slider-thumb{ -webkit-appearance:none; width:18px; height:18px; border-radius:50%;
        background:#fff; border:2.5px solid ${akkuScoreStyles.forest}; cursor:pointer; box-shadow:0 1px 4px rgba(27,67,50,.25); margin-top:-1px;}
      input[type=range]::-moz-range-thumb{ width:16px; height:16px; border-radius:50%; background:#fff;
        border:2.5px solid ${akkuScoreStyles.forest}; cursor:pointer;}
    `;
    document.head.appendChild(s);
  }, []);
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(ControlBar, {
    score: score,
    setScore: setScore
  }), /*#__PURE__*/React.createElement(DesignCanvas, null, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 78
    }
  }), /*#__PURE__*/React.createElement(DCSection, {
    id: "charge",
    title: "Akku Score \u2014 \u201Ccharge\u201D mark",
    subtitle: "Six directions \xB7 live status ramp \xB7 drag the slider above to charge them all"
  }, DIRECTIONS.map(d => /*#__PURE__*/React.createElement(DCArtboard, {
    key: d.variant,
    id: d.variant,
    label: d.title,
    width: 424,
    height: 648
  }, /*#__PURE__*/React.createElement(Direction, {
    variant: d.variant,
    score: score,
    title: d.title,
    desc: d.desc
  })))), /*#__PURE__*/React.createElement(DCSection, {
    id: "logo",
    title: "Same shape, as the logo",
    subtitle: "The identical mark at a fixed \u201Cresting\u201D fill \u2014 monochrome, no number. Judge each on recognisability as the brand icon."
  }, DIRECTIONS.map(d => /*#__PURE__*/React.createElement(DCArtboard, {
    key: d.variant,
    id: 'logo-' + d.variant,
    label: d.title,
    width: 424,
    height: 560
  }, /*#__PURE__*/React.createElement(LogoCard, {
    variant: d.variant,
    title: d.title
  }))))));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(App, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "akku-score/app.jsx", error: String((e && e.message) || e) }); }

// akku-score/charge-marks.js
try { (() => {
/* ============================================================
   AKKU SCORE — "Charge" mark generator
   ------------------------------------------------------------
   One reusable function renders the score mark in any of 6
   visual languages, at any size, for any score 0–100.

     akkuChargeSVG({ variant, score, size, showNumber, track })

   Returns an SVG string. Drop it anywhere:
     el.innerHTML = akkuChargeSVG({ variant:'arc', score:16, size:20 });

   The colour follows a harmonious OKLCH status ramp — warm
   red-orange (low) → amber (mid) → brand forest-green (high) —
   at constant lightness & chroma, so it reads as a single
   family rather than six clashing hues.
   ============================================================ */
(function (global) {
  'use strict';

  var FOREST = '#1B4332'; // brand primary — used for the centred number
  var TRACK = '#DCEBE0'; // unfilled ring — soft mint-grey

  // ---- Status ramp -------------------------------------------------
  // Hue sweeps 28° (red-orange) → 142° (green) as score 0→100.
  // Constant L / C keeps every state equally weighted & elegant.
  function rampColor(score) {
    var s = Math.max(0, Math.min(100, score)) / 100;
    var hue = 28 + s * 114; // 28 → 142
    return 'oklch(63% 0.155 ' + hue.toFixed(1) + ')';
  }
  // A slightly deeper shade of the same hue (for accents / number tint).
  function rampDeep(score) {
    var s = Math.max(0, Math.min(100, score)) / 100;
    var hue = 28 + s * 114;
    return 'oklch(46% 0.13 ' + hue.toFixed(1) + ')';
  }

  // ---- geometry helpers --------------------------------------------
  var CX = 50,
    CY = 50;
  function polar(r, angDeg) {
    var a = (angDeg - 90) * Math.PI / 180;
    return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
  }
  function arcPath(r, a0, a1) {
    var p0 = polar(r, a0),
      p1 = polar(r, a1);
    var large = a1 - a0 > 180 ? 1 : 0;
    return 'M' + p0[0].toFixed(2) + ',' + p0[1].toFixed(2) + ' A' + r + ',' + r + ' 0 ' + large + ' 1 ' + p1[0].toFixed(2) + ',' + p1[1].toFixed(2);
  }
  function numberMarkup(score, opts) {
    if (!opts.showNumber) return '';
    var fs = opts.numberSize || 30;
    var fill = opts.numberColor || FOREST;
    return '<text x="50" y="50" text-anchor="middle" dominant-baseline="central" ' + 'font-family="Outfit, system-ui, sans-serif" font-weight="700" ' + 'font-size="' + fs + '" letter-spacing="-0.5" fill="' + fill + '" ' + 'style="font-variant-numeric:tabular-nums">' + Math.round(score) + '</text>';
  }

  // ============================================================
  // VARIANTS — each returns the inner SVG (viewBox 0 0 100 100)
  // ============================================================
  var variants = {};

  // resolve color / track from opts (enables mono "logo" rendering)
  function resolveCol(score, opts) {
    return opts.color || rampColor(score);
  }
  function resolveTrack(opts) {
    return opts.track === 'none' ? null : opts.track || TRACK;
  }

  // 1 · ARC SWEEP — single rounded arc on a track, 12 o'clock origin.
  variants.arc = function (score, opts) {
    var r = 40,
      w = 9,
      C = 2 * Math.PI * r;
    var p = Math.max(0, Math.min(100, score)) / 100;
    var col = resolveCol(score, opts),
      trk = resolveTrack(opts);
    return '' + (trk ? '<circle cx="50" cy="50" r="' + r + '" fill="none" stroke="' + trk + '" stroke-width="' + w + '"/>' : '') + '<circle cx="50" cy="50" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="' + w + '" ' + 'stroke-linecap="round" stroke-dasharray="' + C.toFixed(2) + '" ' + 'stroke-dashoffset="' + (C * (1 - p)).toFixed(2) + '" transform="rotate(-90 50 50)"/>' + numberMarkup(score, opts);
  };

  // 2 · LIQUID CELL — disc that fills from the bottom with a soft meniscus.
  variants.liquid = function (score, opts) {
    var r = 42;
    var p = Math.max(0, Math.min(100, score)) / 100;
    var col = resolveCol(score, opts);
    var bg = opts.bg === 'none' ? 'none' : opts.bg || '#F2F8F3';
    var level = CY + r - p * (2 * r); // y of the fluid surface
    var amp = 3.2,
      n = 4,
      step = 2 * r / n; // gentle wave
    var wave = 'M' + (CX - r) + ',' + level.toFixed(2);
    for (var i = 0; i < n; i++) {
      var dir = i % 2 === 0 ? -amp : amp;
      var x1 = CX - r + step * (i + 0.5);
      var x2 = CX - r + step * (i + 1);
      wave += ' Q' + x1.toFixed(2) + ',' + (level + dir).toFixed(2) + ' ' + x2.toFixed(2) + ',' + level.toFixed(2);
    }
    wave += ' L' + (CX + r) + ',' + (CY + r) + ' L' + (CX - r) + ',' + (CY + r) + ' Z';
    var uid = 'lq' + Math.random().toString(36).slice(2, 7);
    return '' + '<defs><clipPath id="' + uid + '"><circle cx="50" cy="50" r="' + (r - 1.5) + '"/></clipPath></defs>' + (bg !== 'none' ? '<circle cx="50" cy="50" r="' + (r - 1.5) + '" fill="' + bg + '"/>' : '') + '<g clip-path="url(#' + uid + ')">' + '<path d="' + wave + '" fill="' + col + '"/>' + '<path d="' + wave + '" fill="' + col + '" opacity="0.18" transform="translate(0,-4)"/>' + '</g>' + '<circle cx="50" cy="50" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="3.5"/>' + numberMarkup(score, opts);
  };

  // 3 · GAUGE 270° — open-bottom meter arc.
  variants.gauge = function (score, opts) {
    var r = 40,
      w = 9;
    var p = Math.max(0, Math.min(100, score)) / 100;
    var col = resolveCol(score, opts),
      trk = resolveTrack(opts);
    var a0 = -135,
      a1 = 135,
      end = a0 + (a1 - a0) * p;
    var track = arcPath(r, a0, a1);
    var prog = p > 0.001 ? arcPath(r, a0, end) : '';
    return '' + (trk ? '<path d="' + track + '" fill="none" stroke="' + trk + '" stroke-width="' + w + '" stroke-linecap="round"/>' : '') + (prog ? '<path d="' + prog + '" fill="none" stroke="' + col + '" stroke-width="' + w + '" stroke-linecap="round"/>' : '') + numberMarkup(score, opts);
  };

  // 4 · SEGMENTED RING — 14 capsule ticks; filled count tracks the score.
  variants.segmented = function (score, opts) {
    var n = 14,
      r = 39,
      len = 9,
      w = 6.5;
    var filled = Math.round(Math.max(0, Math.min(100, score)) / 100 * n);
    var col = resolveCol(score, opts),
      trk = resolveTrack(opts);
    var out = '';
    for (var i = 0; i < n; i++) {
      var ang = i / n * 360;
      var a = polar(r + len / 2, ang),
        b = polar(r - len / 2, ang);
      var on = i < filled;
      if (!on && !trk) continue;
      out += '<line x1="' + a[0].toFixed(2) + '" y1="' + a[1].toFixed(2) + '" x2="' + b[0].toFixed(2) + '" y2="' + b[1].toFixed(2) + '" stroke="' + (on ? col : trk) + '" stroke-width="' + w + '" stroke-linecap="round"/>';
    }
    return out + numberMarkup(score, opts);
  };

  // 5 · COMET — sweeping arc with a glowing leading head; energy "charging in".
  variants.comet = function (score, opts) {
    var r = 40,
      w = 8,
      C = 2 * Math.PI * r;
    var p = Math.max(0.0001, Math.min(100, score) / 100);
    var col = resolveCol(score, opts),
      trk = resolveTrack(opts);
    var head = polar(r, p * 360);
    var uid = 'cm' + Math.random().toString(36).slice(2, 7);
    return '' + '<defs><filter id="' + uid + '" x="-50%" y="-50%" width="200%" height="200%">' + '<feGaussianBlur stdDeviation="2.4"/></filter></defs>' + (trk ? '<circle cx="50" cy="50" r="' + r + '" fill="none" stroke="' + trk + '" stroke-width="' + w + '"/>' : '') + '<circle cx="50" cy="50" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="' + w + '" ' + 'stroke-linecap="round" stroke-dasharray="' + C.toFixed(2) + '" ' + 'stroke-dashoffset="' + (C * (1 - p)).toFixed(2) + '" transform="rotate(-90 50 50)"/>' + '<circle cx="' + head[0].toFixed(2) + '" cy="' + head[1].toFixed(2) + '" r="' + w * 0.95 + '" fill="' + col + '" filter="url(#' + uid + ')" opacity="0.55"/>' + '<circle cx="' + head[0].toFixed(2) + '" cy="' + head[1].toFixed(2) + '" r="' + w * 0.62 + '" fill="#fff"/>' + '<circle cx="' + head[0].toFixed(2) + '" cy="' + head[1].toFixed(2) + '" r="' + w * 0.42 + '" fill="' + col + '"/>' + numberMarkup(score, opts);
  };

  // Build an SVG path for a polygon whose corners are rounded by `rad`
  // (viewBox units). rad<=0 falls back to a plain straight-edge polygon.
  function roundedPolyPath(points, rad) {
    var n = points.length;
    if (!(rad > 0)) {
      return 'M' + points.map(function (p) {
        return p[0].toFixed(2) + ',' + p[1].toFixed(2);
      }).join(' L') + ' Z';
    }
    var d = '';
    for (var i = 0; i < n; i++) {
      var prev = points[(i - 1 + n) % n],
        cur = points[i],
        next = points[(i + 1) % n];
      var d1x = prev[0] - cur[0],
        d1y = prev[1] - cur[1],
        l1 = Math.hypot(d1x, d1y) || 1;
      var d2x = next[0] - cur[0],
        d2y = next[1] - cur[1],
        l2 = Math.hypot(d2x, d2y) || 1;
      var r = Math.min(rad, l1 * 0.5, l2 * 0.5);
      var p1 = [cur[0] + d1x / l1 * r, cur[1] + d1y / l1 * r];
      var p2 = [cur[0] + d2x / l2 * r, cur[1] + d2y / l2 * r];
      d += (i === 0 ? 'M' : ' L') + p1[0].toFixed(2) + ',' + p1[1].toFixed(2);
      d += ' Q' + cur[0].toFixed(2) + ',' + cur[1].toFixed(2) + ' ' + p2[0].toFixed(2) + ',' + p2[1].toFixed(2);
    }
    return d + ' Z';
  }

  // 6 · PENNANT RING — folded angular triangles (bolt DNA) that fill round.
  //   opts.pennant = { n, rOut, rIn, gap, round } overrides the geometry:
  //     n     – number of pennants            (default 12)
  //     rOut  – outer base radius / overall size (default 47)
  //     rIn   – apex radius toward centre; smaller = LONGER pennant (default 29)
  //     gap   – angular gap between pennants in deg; bigger = thinner (default 2.6)
  //     round – corner radius in viewBox units; bigger = rounder (default 0)
  variants.pennant = function (score, opts) {
    var P = opts.pennant || {};
    var n = P.n != null ? P.n : 12;
    var rOut = P.rOut != null ? P.rOut : 47;
    var rIn = P.rIn != null ? P.rIn : 29;
    var gap = P.gap != null ? P.gap : 2.6;
    var round = P.round != null ? P.round : 0;
    var slot = 360 / n;
    var filled = Math.round(Math.max(0, Math.min(100, score)) / 100 * n);
    var col = resolveCol(score, opts),
      trk = resolveTrack(opts);
    var out = '';
    for (var i = 0; i < n; i++) {
      var a0 = i * slot + gap,
        a1 = (i + 1) * slot - gap,
        mid = (i + 0.5) * slot;
      // a folded triangle: wide base on the outside, apex toward the centre
      var o0 = polar(rOut, a0),
        o1 = polar(rOut, a1),
        ap = polar(rIn, mid);
      var on = i < filled;
      if (!on && !trk) continue;
      var d = roundedPolyPath([o0, o1, ap], round);
      out += '<path d="' + d + '" fill="' + (on ? col : 'none') + '" ' + 'stroke="' + (on ? col : trk) + '" stroke-width="' + (on ? 1.4 : 2.2) + '" ' + 'stroke-linejoin="round"/>';
    }
    return out + numberMarkup(score, opts);
  };

  // ============================================================
  // PUBLIC API
  // ============================================================
  function akkuChargeSVG(opts) {
    opts = opts || {};
    var variant = opts.variant || 'arc';
    var score = opts.score == null ? 0 : opts.score;
    var size = opts.size || 80;
    var fn = variants[variant] || variants.arc;
    var inner = fn(score, opts);
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" ' + 'width="' + size + '" height="' + size + '" role="img" ' + 'aria-label="Akku score ' + Math.round(score) + ' of 100">' + inner + '</svg>';
  }
  var STATES = [{
    max: 24,
    label: 'Needs charge'
  }, {
    max: 49,
    label: 'Charging'
  }, {
    max: 74,
    label: 'Healthy'
  }, {
    max: 100,
    label: 'Charged'
  }];
  function scoreState(score) {
    for (var i = 0; i < STATES.length; i++) if (score <= STATES[i].max) return STATES[i].label;
    return STATES[STATES.length - 1].label;
  }
  global.akkuChargeSVG = akkuChargeSVG;
  global.akkuRampColor = rampColor;
  global.akkuRampDeep = rampDeep;
  global.akkuScoreState = scoreState;
  global.AKKU_VARIANTS = ['arc', 'liquid', 'gauge', 'segmented', 'comet', 'pennant'];
  // Resting "logo" fill per variant — the signature state that keeps the
  // shape recognisable as a static brand mark (no number, mono colour).
  global.AKKU_BRAND_FILL = {
    arc: 86,
    liquid: 62,
    gauge: 100,
    segmented: 100,
    comet: 78,
    pennant: 100
  };
})(window);
})(); } catch (e) { __ds_ns.__errors.push({ path: "akku-score/charge-marks.js", error: String((e && e.message) || e) }); }

// design-canvas.jsx
try { (() => {
// DesignCanvas.jsx — Figma-ish design canvas wrapper
// Warm gray grid bg + Sections + Artboards + PostIt notes.
// Artboards are reorderable (grip-drag), labels/titles are inline-editable,
// and any artboard can be opened in a fullscreen focus overlay (←/→/Esc).
// State persists to a .design-canvas.state.json sidecar via the host
// bridge. No assets, no deps.
//
// Usage:
//   <DesignCanvas>
//     <DCSection id="onboarding" title="Onboarding" subtitle="First-run variants">
//       <DCArtboard id="a" label="A · Dusk" width={260} height={480}>…</DCArtboard>
//       <DCArtboard id="b" label="B · Minimal" width={260} height={480}>…</DCArtboard>
//     </DCSection>
//   </DesignCanvas>

const DC = {
  bg: '#f0eee9',
  grid: 'rgba(0,0,0,0.06)',
  label: 'rgba(60,50,40,0.7)',
  title: 'rgba(40,30,20,0.85)',
  subtitle: 'rgba(60,50,40,0.6)',
  postitBg: '#fef4a8',
  postitText: '#5a4a2a',
  font: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
};

// One-time CSS injection (classes are dc-prefixed so they don't collide with
// the hosted design's own styles).
if (typeof document !== 'undefined' && !document.getElementById('dc-styles')) {
  const s = document.createElement('style');
  s.id = 'dc-styles';
  s.textContent = ['.dc-editable{cursor:text;outline:none;white-space:nowrap;border-radius:3px;padding:0 2px;margin:0 -2px}', '.dc-editable:focus{background:#fff;box-shadow:0 0 0 1.5px #c96442}', '[data-dc-slot]{transition:transform .18s cubic-bezier(.2,.7,.3,1)}', '[data-dc-slot].dc-dragging{transition:none;z-index:10;pointer-events:none}', '[data-dc-slot].dc-dragging .dc-card{box-shadow:0 12px 40px rgba(0,0,0,.25),0 0 0 2px #c96442;transform:scale(1.02)}', '.dc-card{transition:box-shadow .15s,transform .15s}', '.dc-card *{scrollbar-width:none}', '.dc-card *::-webkit-scrollbar{display:none}', '.dc-labelrow{display:flex;align-items:center;gap:4px;height:24px}', '.dc-grip{cursor:grab;display:flex;align-items:center;padding:5px 4px;border-radius:4px;transition:background .12s}', '.dc-grip:hover{background:rgba(0,0,0,.08)}', '.dc-grip:active{cursor:grabbing}', '.dc-labeltext{cursor:pointer;border-radius:4px;padding:3px 6px;display:flex;align-items:center;transition:background .12s}', '.dc-labeltext:hover{background:rgba(0,0,0,.05)}', '.dc-expand{position:absolute;bottom:100%;right:0;margin-bottom:5px;z-index:2;opacity:0;transition:opacity .12s,background .12s;', '  width:22px;height:22px;border-radius:5px;border:none;cursor:pointer;padding:0;', '  background:transparent;color:rgba(60,50,40,.7);display:flex;align-items:center;justify-content:center}', '.dc-expand:hover{background:rgba(0,0,0,.06);color:#2a251f}', '[data-dc-slot]:hover .dc-expand{opacity:1}'].join('\n');
  document.head.appendChild(s);
}
const DCCtx = React.createContext(null);

// ─────────────────────────────────────────────────────────────
// DesignCanvas — stateful wrapper around the pan/zoom viewport.
// Owns runtime state (per-section order, renamed titles/labels, focused
// artboard). Order/titles/labels persist to a .design-canvas.state.json
// sidecar next to the HTML. Reads go via plain fetch() so the saved
// arrangement is visible anywhere the HTML + sidecar are served together
// (omelette preview, direct link, downloaded zip). Writes go through the
// host's window.omelette bridge — editing requires the omelette runtime.
// Focus is ephemeral.
// ─────────────────────────────────────────────────────────────
const DC_STATE_FILE = '.design-canvas.state.json';
function DesignCanvas({
  children,
  minScale,
  maxScale,
  style
}) {
  const [state, setState] = React.useState({
    sections: {},
    focus: null
  });
  // Hold rendering until the sidecar read settles so the saved order/titles
  // appear on first paint (no source-order flash). didRead gates writes until
  // the read settles so the empty initial state can't clobber a slow read;
  // skipNextWrite suppresses the one echo-write that would otherwise follow
  // hydration.
  const [ready, setReady] = React.useState(false);
  const didRead = React.useRef(false);
  const skipNextWrite = React.useRef(false);
  React.useEffect(() => {
    let off = false;
    fetch('./' + DC_STATE_FILE).then(r => r.ok ? r.json() : null).then(saved => {
      if (off || !saved || !saved.sections) return;
      skipNextWrite.current = true;
      setState(s => ({
        ...s,
        sections: saved.sections
      }));
    }).catch(() => {}).finally(() => {
      didRead.current = true;
      if (!off) setReady(true);
    });
    const t = setTimeout(() => {
      if (!off) setReady(true);
    }, 150);
    return () => {
      off = true;
      clearTimeout(t);
    };
  }, []);
  React.useEffect(() => {
    if (!didRead.current) return;
    if (skipNextWrite.current) {
      skipNextWrite.current = false;
      return;
    }
    const t = setTimeout(() => {
      window.omelette?.writeFile(DC_STATE_FILE, JSON.stringify({
        sections: state.sections
      })).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [state.sections]);

  // Build registries synchronously from children so FocusOverlay can read
  // them in the same render. Only direct DCSection > DCArtboard children are
  // walked — wrapping them in other elements opts out of focus/reorder.
  const registry = {}; // slotId -> { sectionId, artboard }
  const sectionMeta = {}; // sectionId -> { title, subtitle, slotIds[] }
  const sectionOrder = [];
  React.Children.forEach(children, sec => {
    if (!sec || sec.type !== DCSection) return;
    const sid = sec.props.id ?? sec.props.title;
    if (!sid) return;
    sectionOrder.push(sid);
    const persisted = state.sections[sid] || {};
    const srcIds = [];
    React.Children.forEach(sec.props.children, ab => {
      if (!ab || ab.type !== DCArtboard) return;
      const aid = ab.props.id ?? ab.props.label;
      if (!aid) return;
      registry[`${sid}/${aid}`] = {
        sectionId: sid,
        artboard: ab
      };
      srcIds.push(aid);
    });
    const kept = (persisted.order || []).filter(k => srcIds.includes(k));
    sectionMeta[sid] = {
      title: persisted.title ?? sec.props.title,
      subtitle: sec.props.subtitle,
      slotIds: [...kept, ...srcIds.filter(k => !kept.includes(k))]
    };
  });
  const api = React.useMemo(() => ({
    state,
    section: id => state.sections[id] || {},
    patchSection: (id, p) => setState(s => ({
      ...s,
      sections: {
        ...s.sections,
        [id]: {
          ...s.sections[id],
          ...(typeof p === 'function' ? p(s.sections[id] || {}) : p)
        }
      }
    })),
    setFocus: slotId => setState(s => ({
      ...s,
      focus: slotId
    }))
  }), [state]);

  // Esc exits focus; any outside pointerdown commits an in-progress rename.
  React.useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') api.setFocus(null);
    };
    const onPd = e => {
      const ae = document.activeElement;
      if (ae && ae.isContentEditable && !ae.contains(e.target)) ae.blur();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPd, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPd, true);
    };
  }, [api]);
  return /*#__PURE__*/React.createElement(DCCtx.Provider, {
    value: api
  }, /*#__PURE__*/React.createElement(DCViewport, {
    minScale: minScale,
    maxScale: maxScale,
    style: style
  }, ready && children), state.focus && registry[state.focus] && /*#__PURE__*/React.createElement(DCFocusOverlay, {
    entry: registry[state.focus],
    sectionMeta: sectionMeta,
    sectionOrder: sectionOrder
  }));
}

// ─────────────────────────────────────────────────────────────
// DCViewport — transform-based pan/zoom (internal)
//
// Input mapping (Figma-style):
//   • trackpad pinch  → zoom   (ctrlKey wheel; Safari gesture* events)
//   • trackpad scroll → pan    (two-finger)
//   • mouse wheel     → zoom   (notched; distinguished from trackpad scroll)
//   • middle-drag / primary-drag-on-bg → pan
//
// Transform state lives in a ref and is written straight to the DOM
// (translate3d + will-change) so wheel ticks don't go through React —
// keeps pans at 60fps on dense canvases.
// ─────────────────────────────────────────────────────────────
function DCViewport({
  children,
  minScale = 0.1,
  maxScale = 8,
  style = {}
}) {
  const vpRef = React.useRef(null);
  const worldRef = React.useRef(null);
  const tf = React.useRef({
    x: 0,
    y: 0,
    scale: 1
  });
  const apply = React.useCallback(() => {
    const {
      x,
      y,
      scale
    } = tf.current;
    const el = worldRef.current;
    if (el) el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
  }, []);
  React.useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const zoomAt = (cx, cy, factor) => {
      const r = vp.getBoundingClientRect();
      const px = cx - r.left,
        py = cy - r.top;
      const t = tf.current;
      const next = Math.min(maxScale, Math.max(minScale, t.scale * factor));
      const k = next / t.scale;
      // keep the world point under the cursor fixed
      t.x = px - (px - t.x) * k;
      t.y = py - (py - t.y) * k;
      t.scale = next;
      apply();
    };

    // Mouse-wheel vs trackpad-scroll heuristic. A physical wheel sends
    // line-mode deltas (Firefox) or large integer pixel deltas with no X
    // component (Chrome/Safari, typically multiples of 100/120). Trackpad
    // two-finger scroll sends small/fractional pixel deltas, often with
    // non-zero deltaX. ctrlKey is set by the browser for trackpad pinch.
    const isMouseWheel = e => e.deltaMode !== 0 || e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40;
    const onWheel = e => {
      e.preventDefault();
      if (isGesturing) return; // Safari: gesture* owns the pinch — discard concurrent wheels
      if (e.ctrlKey) {
        // trackpad pinch (or explicit ctrl+wheel)
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
      } else if (isMouseWheel(e)) {
        // notched mouse wheel — fixed-ratio step per click
        zoomAt(e.clientX, e.clientY, Math.exp(-Math.sign(e.deltaY) * 0.18));
      } else {
        // trackpad two-finger scroll — pan
        tf.current.x -= e.deltaX;
        tf.current.y -= e.deltaY;
        apply();
      }
    };

    // Safari sends native gesture* events for trackpad pinch with a smooth
    // e.scale; preferring these over the ctrl+wheel fallback gives a much
    // better feel there. No-ops on other browsers. Safari also fires
    // ctrlKey wheel events during the same pinch — isGesturing makes
    // onWheel drop those entirely so they neither zoom nor pan.
    let gsBase = 1;
    let isGesturing = false;
    const onGestureStart = e => {
      e.preventDefault();
      isGesturing = true;
      gsBase = tf.current.scale;
    };
    const onGestureChange = e => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, gsBase * e.scale / tf.current.scale);
    };
    const onGestureEnd = e => {
      e.preventDefault();
      isGesturing = false;
    };

    // Drag-pan: middle button anywhere, or primary button on canvas
    // background (anything that isn't an artboard or an inline editor).
    let drag = null;
    const onPointerDown = e => {
      const onBg = !e.target.closest('[data-dc-slot], .dc-editable');
      if (!(e.button === 1 || e.button === 0 && onBg)) return;
      e.preventDefault();
      vp.setPointerCapture(e.pointerId);
      drag = {
        id: e.pointerId,
        lx: e.clientX,
        ly: e.clientY
      };
      vp.style.cursor = 'grabbing';
    };
    const onPointerMove = e => {
      if (!drag || e.pointerId !== drag.id) return;
      tf.current.x += e.clientX - drag.lx;
      tf.current.y += e.clientY - drag.ly;
      drag.lx = e.clientX;
      drag.ly = e.clientY;
      apply();
    };
    const onPointerUp = e => {
      if (!drag || e.pointerId !== drag.id) return;
      vp.releasePointerCapture(e.pointerId);
      drag = null;
      vp.style.cursor = '';
    };
    vp.addEventListener('wheel', onWheel, {
      passive: false
    });
    vp.addEventListener('gesturestart', onGestureStart, {
      passive: false
    });
    vp.addEventListener('gesturechange', onGestureChange, {
      passive: false
    });
    vp.addEventListener('gestureend', onGestureEnd, {
      passive: false
    });
    vp.addEventListener('pointerdown', onPointerDown);
    vp.addEventListener('pointermove', onPointerMove);
    vp.addEventListener('pointerup', onPointerUp);
    vp.addEventListener('pointercancel', onPointerUp);
    return () => {
      vp.removeEventListener('wheel', onWheel);
      vp.removeEventListener('gesturestart', onGestureStart);
      vp.removeEventListener('gesturechange', onGestureChange);
      vp.removeEventListener('gestureend', onGestureEnd);
      vp.removeEventListener('pointerdown', onPointerDown);
      vp.removeEventListener('pointermove', onPointerMove);
      vp.removeEventListener('pointerup', onPointerUp);
      vp.removeEventListener('pointercancel', onPointerUp);
    };
  }, [apply, minScale, maxScale]);
  const gridSvg = `url("data:image/svg+xml,%3Csvg width='120' height='120' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M120 0H0v120' fill='none' stroke='${encodeURIComponent(DC.grid)}' stroke-width='1'/%3E%3C/svg%3E")`;
  return /*#__PURE__*/React.createElement("div", {
    ref: vpRef,
    className: "design-canvas",
    style: {
      height: '100vh',
      width: '100vw',
      background: DC.bg,
      overflow: 'hidden',
      overscrollBehavior: 'none',
      touchAction: 'none',
      position: 'relative',
      fontFamily: DC.font,
      boxSizing: 'border-box',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    ref: worldRef,
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      transformOrigin: '0 0',
      willChange: 'transform',
      width: 'max-content',
      minWidth: '100%',
      minHeight: '100%',
      padding: '60px 0 80px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: -6000,
      backgroundImage: gridSvg,
      backgroundSize: '120px 120px',
      pointerEvents: 'none',
      zIndex: -1
    }
  }), children));
}

// ─────────────────────────────────────────────────────────────
// DCSection — editable title + h-row of artboards in persisted order
// ─────────────────────────────────────────────────────────────
function DCSection({
  id,
  title,
  subtitle,
  children,
  gap = 48
}) {
  const ctx = React.useContext(DCCtx);
  const sid = id ?? title;
  const all = React.Children.toArray(children);
  const artboards = all.filter(c => c && c.type === DCArtboard);
  const rest = all.filter(c => !(c && c.type === DCArtboard));
  const srcOrder = artboards.map(a => a.props.id ?? a.props.label);
  const sec = ctx && sid && ctx.section(sid) || {};
  const order = React.useMemo(() => {
    const kept = (sec.order || []).filter(k => srcOrder.includes(k));
    return [...kept, ...srcOrder.filter(k => !kept.includes(k))];
  }, [sec.order, srcOrder.join('|')]);
  const byId = Object.fromEntries(artboards.map(a => [a.props.id ?? a.props.label, a]));
  return /*#__PURE__*/React.createElement("div", {
    "data-dc-section": sid,
    style: {
      marginBottom: 80,
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 60px 56px'
    }
  }, /*#__PURE__*/React.createElement(DCEditable, {
    tag: "div",
    value: sec.title ?? title,
    onChange: v => ctx && sid && ctx.patchSection(sid, {
      title: v
    }),
    style: {
      fontSize: 28,
      fontWeight: 600,
      color: DC.title,
      letterSpacing: -0.4,
      marginBottom: 6,
      display: 'inline-block'
    }
  }), subtitle && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 16,
      color: DC.subtitle
    }
  }, subtitle)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap,
      padding: '0 60px',
      alignItems: 'flex-start',
      width: 'max-content'
    }
  }, order.map(k => /*#__PURE__*/React.createElement(DCArtboardFrame, {
    key: k,
    sectionId: sid,
    artboard: byId[k],
    order: order,
    label: (sec.labels || {})[k] ?? byId[k].props.label,
    onRename: v => ctx && ctx.patchSection(sid, x => ({
      labels: {
        ...x.labels,
        [k]: v
      }
    })),
    onReorder: next => ctx && ctx.patchSection(sid, {
      order: next
    }),
    onFocus: () => ctx && ctx.setFocus(`${sid}/${k}`)
  }))), rest);
}

// DCArtboard — marker; rendered by DCArtboardFrame via DCSection.
function DCArtboard() {
  return null;
}
function DCArtboardFrame({
  sectionId,
  artboard,
  label,
  order,
  onRename,
  onReorder,
  onFocus
}) {
  const {
    id: rawId,
    label: rawLabel,
    width = 260,
    height = 480,
    children,
    style = {}
  } = artboard.props;
  const id = rawId ?? rawLabel;
  const ref = React.useRef(null);

  // Live drag-reorder: dragged card sticks to cursor; siblings slide into
  // their would-be slots in real time via transforms. DOM order only
  // changes on drop.
  const onGripDown = e => {
    e.preventDefault();
    e.stopPropagation();
    const me = ref.current;
    // translateX is applied in local (pre-scale) space but pointer deltas and
    // getBoundingClientRect().left are screen-space — divide by the viewport's
    // current scale so the dragged card tracks the cursor at any zoom level.
    const scale = me.getBoundingClientRect().width / me.offsetWidth || 1;
    const peers = Array.from(document.querySelectorAll(`[data-dc-section="${sectionId}"] [data-dc-slot]`));
    const homes = peers.map(el => ({
      el,
      id: el.dataset.dcSlot,
      x: el.getBoundingClientRect().left
    }));
    const slotXs = homes.map(h => h.x);
    const startIdx = order.indexOf(id);
    const startX = e.clientX;
    let liveOrder = order.slice();
    me.classList.add('dc-dragging');
    const layout = () => {
      for (const h of homes) {
        if (h.id === id) continue;
        const slot = liveOrder.indexOf(h.id);
        h.el.style.transform = `translateX(${(slotXs[slot] - h.x) / scale}px)`;
      }
    };
    const move = ev => {
      const dx = ev.clientX - startX;
      me.style.transform = `translateX(${dx / scale}px)`;
      const cur = homes[startIdx].x + dx;
      let nearest = 0,
        best = Infinity;
      for (let i = 0; i < slotXs.length; i++) {
        const d = Math.abs(slotXs[i] - cur);
        if (d < best) {
          best = d;
          nearest = i;
        }
      }
      if (liveOrder.indexOf(id) !== nearest) {
        liveOrder = order.filter(k => k !== id);
        liveOrder.splice(nearest, 0, id);
        layout();
      }
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      const finalSlot = liveOrder.indexOf(id);
      me.classList.remove('dc-dragging');
      me.style.transform = `translateX(${(slotXs[finalSlot] - homes[startIdx].x) / scale}px)`;
      // After the settle transition, kill transitions + clear transforms +
      // commit the reorder in the same frame so there's no visual snap-back.
      setTimeout(() => {
        for (const h of homes) {
          h.el.style.transition = 'none';
          h.el.style.transform = '';
        }
        if (liveOrder.join('|') !== order.join('|')) onReorder(liveOrder);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          for (const h of homes) h.el.style.transition = '';
        }));
      }, 180);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };
  return /*#__PURE__*/React.createElement("div", {
    ref: ref,
    "data-dc-slot": id,
    style: {
      position: 'relative',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "dc-labelrow",
    style: {
      position: 'absolute',
      bottom: '100%',
      left: -4,
      marginBottom: 4,
      color: DC.label
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "dc-grip",
    onPointerDown: onGripDown,
    title: "Drag to reorder"
  }, /*#__PURE__*/React.createElement("svg", {
    width: "9",
    height: "13",
    viewBox: "0 0 9 13",
    fill: "currentColor"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "2",
    cy: "2",
    r: "1.1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "7",
    cy: "2",
    r: "1.1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "2",
    cy: "6.5",
    r: "1.1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "7",
    cy: "6.5",
    r: "1.1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "2",
    cy: "11",
    r: "1.1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "7",
    cy: "11",
    r: "1.1"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "dc-labeltext",
    onClick: onFocus,
    title: "Click to focus"
  }, /*#__PURE__*/React.createElement(DCEditable, {
    value: label,
    onChange: onRename,
    onClick: e => e.stopPropagation(),
    style: {
      fontSize: 15,
      fontWeight: 500,
      color: DC.label,
      lineHeight: 1
    }
  }))), /*#__PURE__*/React.createElement("button", {
    className: "dc-expand",
    onClick: onFocus,
    onPointerDown: e => e.stopPropagation(),
    title: "Focus"
  }, /*#__PURE__*/React.createElement("svg", {
    width: "12",
    height: "12",
    viewBox: "0 0 12 12",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.6",
    strokeLinecap: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M7 1h4v4M5 11H1V7M11 1L7.5 4.5M1 11l3.5-3.5"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "dc-card",
    style: {
      borderRadius: 2,
      boxShadow: '0 1px 3px rgba(0,0,0,.08),0 4px 16px rgba(0,0,0,.06)',
      overflow: 'hidden',
      width,
      height,
      background: '#fff',
      ...style
    }
  }, children || /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#bbb',
      fontSize: 13,
      fontFamily: DC.font
    }
  }, id)));
}

// Inline rename — commits on blur or Enter.
function DCEditable({
  value,
  onChange,
  style,
  tag = 'span',
  onClick
}) {
  const T = tag;
  return /*#__PURE__*/React.createElement(T, {
    className: "dc-editable",
    contentEditable: true,
    suppressContentEditableWarning: true,
    onClick: onClick,
    onPointerDown: e => e.stopPropagation(),
    onBlur: e => onChange && onChange(e.currentTarget.textContent),
    onKeyDown: e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.currentTarget.blur();
      }
    },
    style: style
  }, value);
}

// ─────────────────────────────────────────────────────────────
// Focus mode — overlay one artboard; ←/→ within section, ↑/↓ across
// sections, Esc or backdrop click to exit.
// ─────────────────────────────────────────────────────────────
function DCFocusOverlay({
  entry,
  sectionMeta,
  sectionOrder
}) {
  const ctx = React.useContext(DCCtx);
  const {
    sectionId,
    artboard
  } = entry;
  const sec = ctx.section(sectionId);
  const meta = sectionMeta[sectionId];
  const peers = meta.slotIds;
  const aid = artboard.props.id ?? artboard.props.label;
  const idx = peers.indexOf(aid);
  const secIdx = sectionOrder.indexOf(sectionId);
  const go = d => {
    const n = peers[(idx + d + peers.length) % peers.length];
    if (n) ctx.setFocus(`${sectionId}/${n}`);
  };
  const goSection = d => {
    const ns = sectionOrder[(secIdx + d + sectionOrder.length) % sectionOrder.length];
    const first = sectionMeta[ns] && sectionMeta[ns].slotIds[0];
    if (first) ctx.setFocus(`${ns}/${first}`);
  };
  React.useEffect(() => {
    const k = e => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        go(-1);
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        go(1);
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        goSection(-1);
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        goSection(1);
      }
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  });
  const {
    width = 260,
    height = 480,
    children
  } = artboard.props;
  const [vp, setVp] = React.useState({
    w: window.innerWidth,
    h: window.innerHeight
  });
  React.useEffect(() => {
    const r = () => setVp({
      w: window.innerWidth,
      h: window.innerHeight
    });
    window.addEventListener('resize', r);
    return () => window.removeEventListener('resize', r);
  }, []);
  const scale = Math.max(0.1, Math.min((vp.w - 200) / width, (vp.h - 260) / height, 2));
  const [ddOpen, setDd] = React.useState(false);
  const Arrow = ({
    dir,
    onClick
  }) => /*#__PURE__*/React.createElement("button", {
    onClick: e => {
      e.stopPropagation();
      onClick();
    },
    style: {
      position: 'absolute',
      top: '50%',
      [dir]: 28,
      transform: 'translateY(-50%)',
      border: 'none',
      background: 'rgba(255,255,255,.08)',
      color: 'rgba(255,255,255,.9)',
      width: 44,
      height: 44,
      borderRadius: 22,
      fontSize: 18,
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'background .15s'
    },
    onMouseEnter: e => e.currentTarget.style.background = 'rgba(255,255,255,.18)',
    onMouseLeave: e => e.currentTarget.style.background = 'rgba(255,255,255,.08)'
  }, /*#__PURE__*/React.createElement("svg", {
    width: "18",
    height: "18",
    viewBox: "0 0 18 18",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: dir === 'left' ? 'M11 3L5 9l6 6' : 'M7 3l6 6-6 6'
  })));

  // Portal to body so position:fixed is the real viewport regardless of any
  // transform on DesignCanvas's ancestors (including the canvas zoom itself).
  return ReactDOM.createPortal(/*#__PURE__*/React.createElement("div", {
    onClick: () => ctx.setFocus(null),
    onWheel: e => e.preventDefault(),
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 100,
      background: 'rgba(24,20,16,.6)',
      backdropFilter: 'blur(14px)',
      fontFamily: DC.font,
      color: '#fff'
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 72,
      display: 'flex',
      alignItems: 'flex-start',
      padding: '16px 20px 0',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setDd(o => !o),
    style: {
      border: 'none',
      background: 'transparent',
      color: '#fff',
      cursor: 'pointer',
      padding: '6px 8px',
      borderRadius: 6,
      textAlign: 'left',
      fontFamily: 'inherit'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 18,
      fontWeight: 600,
      letterSpacing: -0.3
    }
  }, meta.title), /*#__PURE__*/React.createElement("svg", {
    width: "11",
    height: "11",
    viewBox: "0 0 11 11",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    style: {
      opacity: .7
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: "M2 4l3.5 3.5L9 4"
  }))), meta.subtitle && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontSize: 13,
      opacity: .6,
      fontWeight: 400,
      marginTop: 2
    }
  }, meta.subtitle)), ddOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: '100%',
      left: 0,
      marginTop: 4,
      background: '#2a251f',
      borderRadius: 8,
      boxShadow: '0 8px 32px rgba(0,0,0,.4)',
      padding: 4,
      minWidth: 200,
      zIndex: 10
    }
  }, sectionOrder.map(sid => /*#__PURE__*/React.createElement("button", {
    key: sid,
    onClick: () => {
      setDd(false);
      const f = sectionMeta[sid].slotIds[0];
      if (f) ctx.setFocus(`${sid}/${f}`);
    },
    style: {
      display: 'block',
      width: '100%',
      textAlign: 'left',
      border: 'none',
      cursor: 'pointer',
      background: sid === sectionId ? 'rgba(255,255,255,.1)' : 'transparent',
      color: '#fff',
      padding: '8px 12px',
      borderRadius: 5,
      fontSize: 14,
      fontWeight: sid === sectionId ? 600 : 400,
      fontFamily: 'inherit'
    }
  }, sectionMeta[sid].title)))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => ctx.setFocus(null),
    onMouseEnter: e => e.currentTarget.style.background = 'rgba(255,255,255,.12)',
    onMouseLeave: e => e.currentTarget.style.background = 'transparent',
    style: {
      border: 'none',
      background: 'transparent',
      color: 'rgba(255,255,255,.7)',
      width: 32,
      height: 32,
      borderRadius: 16,
      fontSize: 20,
      cursor: 'pointer',
      lineHeight: 1,
      transition: 'background .12s'
    }
  }, "\xD7")), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 64,
      bottom: 56,
      left: 100,
      right: 100,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      width: width * scale,
      height: height * scale,
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width,
      height,
      transform: `scale(${scale})`,
      transformOrigin: 'top left',
      background: '#fff',
      borderRadius: 2,
      overflow: 'hidden',
      boxShadow: '0 20px 80px rgba(0,0,0,.4)'
    }
  }, children || /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#bbb'
    }
  }, aid))), /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      fontSize: 14,
      fontWeight: 500,
      opacity: .85,
      textAlign: 'center'
    }
  }, (sec.labels || {})[aid] ?? artboard.props.label, /*#__PURE__*/React.createElement("span", {
    style: {
      opacity: .5,
      marginLeft: 10,
      fontVariantNumeric: 'tabular-nums'
    }
  }, idx + 1, " / ", peers.length))), /*#__PURE__*/React.createElement(Arrow, {
    dir: "left",
    onClick: () => go(-1)
  }), /*#__PURE__*/React.createElement(Arrow, {
    dir: "right",
    onClick: () => go(1)
  }), /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      position: 'absolute',
      bottom: 20,
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      gap: 8
    }
  }, peers.map((p, i) => /*#__PURE__*/React.createElement("button", {
    key: p,
    onClick: () => ctx.setFocus(`${sectionId}/${p}`),
    style: {
      border: 'none',
      padding: 0,
      cursor: 'pointer',
      width: 6,
      height: 6,
      borderRadius: 3,
      background: i === idx ? '#fff' : 'rgba(255,255,255,.3)'
    }
  })))), document.body);
}

// ─────────────────────────────────────────────────────────────
// Post-it — absolute-positioned sticky note
// ─────────────────────────────────────────────────────────────
function DCPostIt({
  children,
  top,
  left,
  right,
  bottom,
  rotate = -2,
  width = 180
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top,
      left,
      right,
      bottom,
      width,
      background: DC.postitBg,
      padding: '14px 16px',
      fontFamily: '"Comic Sans MS", "Marker Felt", "Segoe Print", cursive',
      fontSize: 14,
      lineHeight: 1.4,
      color: DC.postitText,
      boxShadow: '0 2px 8px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08)',
      transform: `rotate(${rotate}deg)`,
      zIndex: 5
    }
  }, children);
}
Object.assign(window, {
  DesignCanvas,
  DCSection,
  DCArtboard,
  DCPostIt
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "design-canvas.jsx", error: String((e && e.message) || e) }); }

__ds_ns.AkkuLogo = __ds_scope.AkkuLogo;

})();
